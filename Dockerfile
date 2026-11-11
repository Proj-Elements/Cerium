FROM golang:1.26-alpine@sha256:30b1e546a9c7fa3b747c2bdba3a0c7bdf3a02ebb4c5b8405d2f948d7e8aac4ec AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY cmd ./cmd
COPY contracts ./contracts
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -buildvcs=false -trimpath -ldflags='-s -w' -o /cerium ./cmd/cerium

FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN adduser -D -u 10001 cerium && mkdir -m 700 /data && chown cerium:cerium /data
USER cerium
WORKDIR /app
COPY --from=build /cerium /app/cerium
VOLUME /data
ENTRYPOINT ["/app/cerium"]
CMD ["serve", "-db", "/data/cerium.db", "-listen", "127.0.0.1:8091"]
