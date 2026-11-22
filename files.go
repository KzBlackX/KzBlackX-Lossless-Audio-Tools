package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Temporary room files. Metadata lives in memory and the bytes live on disk;
// the directory is disposable across restarts.

type fileMeta struct {
	fileInfo
	Room string
	Path string
}

func newToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return newID() + newID() + newID() + newID()
	}
	return hex.EncodeToString(b)
}

func (h *Hub) initFiles() error {
	if err := os.MkdirAll(h.cfg.FilesDir, 0o700); err != nil {
		return fmt.Errorf("create files directory %s: %w", h.cfg.FilesDir, err)
	}
	h.fileDir = h.cfg.FilesDir
	// Metadata is in memory only, so files from a previous process are
	// unreachable. The directory is dedicated to this server; remove only
	// files this version creates there.
	entries, err := os.ReadDir(h.fileDir)
	if err != nil {
		return fmt.Errorf("read files directory: %w", err)
	}
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if strings.HasPrefix(name, ".upload-") || strings.HasSuffix(name, ".bin") {
			_ = os.Remove(filepath.Join(h.fileDir, name))
		}
	}
	return nil
}

func (h *Hub) filesLoop() {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-ticker.C:
			h.cleanupFiles()
		}
	}
}

type removedFile struct {
	room string
	id   string
	path string
}

func (h *Hub) cleanupFiles() {
	now := time.Now()
	var removed []removedFile
	h.mu.Lock()
	for id, f := range h.files {
		old := now.Sub(time.UnixMilli(f.TS)) > h.cfg.FileTTL
		noRoom := h.rooms[f.Room] == nil
		if !old && !noRoom {
			continue
		}
		delete(h.files, id)
		removed = append(removed, removedFile{room: f.Room, id: id, path: f.Path})
	}
	h.mu.Unlock()
	for _, r := range removed {
		_ = os.Remove(r.path)
		if room := h.roomByName(r.room); room != nil {
			h.broadcast(room, "", msgFileRemoved{T: "file-removed", ID: r.id})
		}
	}
}

func (h *Hub) purgeRoomFiles(roomName string) {
	var paths []string
	h.mu.Lock()
	for id, f := range h.files {
		if f.Room == roomName {
			delete(h.files, id)
			paths = append(paths, f.Path)
		}
	}
	h.mu.Unlock()
	for _, p := range paths {
		_ = os.Remove(p)
	}
}

func (h *Hub) roomByName(name string) *Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[name]
}

// fileListLocked must be called with h.mu held.
func (h *Hub) fileListLocked(room string) []fileInfo {
	out := make([]fileInfo, 0)
	for _, f := range h.files {
		if f.Room == room {
			out = append(out, f.fileInfo)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}

func (h *Hub) addFile(meta *fileMeta) {
	h.mu.Lock()
	h.files[meta.ID] = meta
	h.mu.Unlock()
	if room := h.roomByName(meta.Room); room != nil {
		h.broadcast(room, "", msgFileShared{T: "file-shared", File: meta.fileInfo})
	}
}

func (h *Hub) fileByID(id string) *fileMeta {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.files[id]
}

func (h *Hub) peerByToken(token string) *Peer {
	if token == "" {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.tokens[token]
}

func bearerToken(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}

func cleanFileName(s string) string {
	s = strings.TrimSpace(s)
	s = filepath.Base(s)
	var b strings.Builder
	for _, r := range s {
		if r < 32 || r == 127 || r == '/' || r == '\\' {
			continue
		}
		b.WriteRune(r)
	}
	s = strings.TrimSpace(b.String())
	if s == "" || s == "." || s == ".." {
		s = "file"
	}
	if runes := []rune(s); len(runes) > 160 {
		s = string(runes[:160])
	}
	return s
}

func maxFileBytes(cfg *Config) int64 { return int64(cfg.MaxFileMB) << 20 }

func (a *App) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	peer := a.hub.peerByToken(bearerToken(r))
	if peer == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	roomName := cleanRoom(r.URL.Query().Get("room"))
	a.hub.mu.RLock()
	room := peer.room
	a.hub.mu.RUnlock()
	if room == nil || room.Name != roomName {
		http.Error(w, "not in this room", http.StatusForbidden)
		return
	}
	fileToken := room.FileToken
	limit := maxFileBytes(a.cfg)

	r.Body = http.MaxBytesReader(w, r.Body, limit+2<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "expected multipart form", http.StatusBadRequest)
		return
	}
	var (
		saved    *fileMeta
		tmpPath  string
		fileName string
		fileMIME string
		fileSize int64
	)
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			http.Error(w, "bad upload", http.StatusBadRequest)
			if tmpPath != "" {
				_ = os.Remove(tmpPath)
			}
			return
		}
		if part.FormName() != "file" || part.FileName() == "" {
			_ = part.Close()
			continue
		}
		fileName = cleanFileName(part.FileName())
		fileMIME = part.Header.Get("Content-Type")
		tmp, err := os.CreateTemp(a.hub.fileDir, ".upload-*")
		if err != nil {
			_ = part.Close()
			http.Error(w, "cannot store file", http.StatusInternalServerError)
			return
		}
		tmpPath = tmp.Name()
		n, copyErr := io.Copy(tmp, io.LimitReader(part, limit+1))
		_ = tmp.Close()
		_ = part.Close()
		if copyErr != nil {
			_ = os.Remove(tmpPath)
			http.Error(w, "upload interrupted", http.StatusBadRequest)
			return
		}
		if n > limit {
			_ = os.Remove(tmpPath)
			http.Error(w, fmt.Sprintf("file larger than %d MiB", a.cfg.MaxFileMB), http.StatusRequestEntityTooLarge)
			return
		}
		if n == 0 {
			_ = os.Remove(tmpPath)
			http.Error(w, "empty file", http.StatusBadRequest)
			return
		}
		fileSize = n
		break
	}
	if tmpPath == "" {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	if fileMIME == "" || fileMIME == "application/octet-stream" {
		if byExt := mime.TypeByExtension(filepath.Ext(fileName)); byExt != "" {
			fileMIME = byExt
		}
	}
	if fileMIME == "" {
		fileMIME = "application/octet-stream"
	}
	id := newToken()
	finalPath := filepath.Join(a.hub.fileDir, id+".bin")
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		http.Error(w, "cannot store file", http.StatusInternalServerError)
		return
	}
	saved = &fileMeta{
		fileInfo: fileInfo{
			ID:     id,
			Name:   fileName,
			Size:   fileSize,
			MIME:   fileMIME,
			From:   peer.name,
			FromID: peer.id,
			TS:     time.Now().UnixMilli(),
		},
		Room: room.Name,
		Path: finalPath,
	}
	a.hub.addFile(saved)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"file": saved.fileInfo,
		"url":  "/api/files/" + saved.ID + "?token=" + fileToken,
	})
}

func (a *App) handleFileDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/files/")
	if id == "" || strings.ContainsAny(id, "/\\") {
		http.NotFound(w, r)
		return
	}
	meta := a.hub.fileByID(id)
	if meta == nil {
		http.NotFound(w, r)
		return
	}
	room := a.hub.roomByName(meta.Room)
	if room == nil || !constantTimeEqual(bearerToken(r), room.FileToken) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	f, err := os.Open(meta.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	disp := mime.FormatMediaType("attachment", map[string]string{"filename": meta.Name})
	if disp == "" {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", disp)
	w.Header().Set("Content-Type", meta.MIME)
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, meta.Name, info.ModTime(), f)
}
