package main

import (
	"strings"
	"testing"
)

const sampleAnswer = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" +
	"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" +
	"a=rtpmap:111 opus/48000/2\r\n" +
	"a=fmtp:111 minptime=10;useinbandfec=1\r\n" +
	"a=sendrecv\r\n"

func TestPatchOpusSDPHighQuality(t *testing.T) {
	out := patchOpusSDP(sampleAnswer, 320)
	for _, want := range []string{
		"maxaveragebitrate=320000", "stereo=1", "sprop-stereo=1",
		"usedtx=0", "maxplaybackrate=48000", "useinbandfec=1",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %q", want, out)
		}
	}
	if strings.Count(out, "a=fmtp:111") != 1 {
		t.Fatalf("expected exactly one fmtp line, got %q", out)
	}
}

func TestPatchOpusSDPMono(t *testing.T) {
	out := patchOpusSDP(sampleAnswer, 32)
	if !strings.Contains(out, "stereo=0") || !strings.Contains(out, "sprop-stereo=0") {
		t.Fatalf("voice profile should be mono: %q", out)
	}
	if !strings.Contains(out, "maxaveragebitrate=32000") {
		t.Fatalf("wrong bitrate: %q", out)
	}
}

func TestPatchOpusSDPInsertsFmtp(t *testing.T) {
	sdp := "v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\na=sendrecv\n"
	out := patchOpusSDP(sdp, 96)
	if !strings.Contains(out, "a=fmtp:111 ") || !strings.Contains(out, "maxaveragebitrate=96000") {
		t.Fatalf("fmtp not inserted: %q", out)
	}
	if strings.Contains(out, "\r\n") {
		t.Fatalf("line endings changed: %q", out)
	}
}

func TestPatchOpusSDPNoOpus(t *testing.T) {
	sdp := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\n"
	if got := patchOpusSDP(sdp, 320); got != sdp {
		t.Fatalf("non-opus SDP must be untouched")
	}
}

func TestPatchOpusSDPClampsBitrate(t *testing.T) {
	out := patchOpusSDP(sampleAnswer, 9999)
	if !strings.Contains(out, "maxaveragebitrate=510000") {
		t.Fatalf("bitrate not clamped: %q", out)
	}
}
