# a09f account service (Go). Static binary on a small base image.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /a09f-api .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 a09f
COPY --from=build /a09f-api /a09f-api
USER a09f
EXPOSE 8080
ENTRYPOINT ["/a09f-api"]
