# a09f account service (Go) + sojuctl.
# sojuctl is copied from the exact soju image docker-compose runs, so the
# admin-socket protocol always matches the running bouncer.
ARG SOJU_IMAGE=codeberg.org/emersion/soju@sha256:c695fb996dce168fb39449415c7523b17189ed81b48c107d4728fc93fb30e799

FROM ${SOJU_IMAGE} AS soju

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /a09f-api .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=soju /sojuctl /usr/local/bin/sojuctl
COPY --from=build /a09f-api /a09f-api
# Runs as root like the Python service did: soju's admin socket in the
# soju-db volume is only writable by root.
EXPOSE 8080
ENTRYPOINT ["/a09f-api"]
