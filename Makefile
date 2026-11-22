VERSION ?= 0.1.0
GOFLAGS ?=
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test vet dist run docker clean
build:
	CGO_ENABLED=0 go build $(GOFLAGS) -trimpath -ldflags "$(LDFLAGS)" -o dist/kzblackx-audio .

test:
	go test ./...

vet:
	go vet ./...

dist:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/kzblackx-audio-linux-amd64 .
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/kzblackx-audio-linux-arm64 .

run:
	go run . --addr 127.0.0.1:8080 --password dev --rooms 大厅,游戏

docker:
	docker build -t kzblackx-audio:$(VERSION) -f deploy/Dockerfile .

clean:
	rm -rf dist
