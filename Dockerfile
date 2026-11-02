FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /cerium ./cmd/cerium

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 cerium && mkdir -m 700 /data && chown cerium:cerium /data
USER cerium
WORKDIR /app
COPY --from=build /cerium /app/cerium
VOLUME /data
ENTRYPOINT ["/app/cerium"]
CMD ["serve", "-db", "/data/cerium.db", "-listen", "127.0.0.1:8091"]
