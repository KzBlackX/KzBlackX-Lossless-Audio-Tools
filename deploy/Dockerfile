# Build a small static image. Run with host networking so the single UDP media
# port is directly reachable (no docker NAT surprises).
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/kzblackx-audio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -H -u 10001 kzblackx \
    && mkdir -p /var/lib/kzblackx/files && chown -R kzblackx:kzblackx /var/lib/kzblackx
COPY --from=build /out/kzblackx-audio /usr/local/bin/kzblackx-audio
WORKDIR /var/lib/kzblackx
USER kzblackx
EXPOSE 8080
EXPOSE 3478/udp
ENTRYPOINT ["/usr/local/bin/kzblackx-audio"]
