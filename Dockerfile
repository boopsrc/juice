# Stage 1: Build the Go server binary
FROM golang:1.26-alpine AS builder

# Set directory inside build container
WORKDIR /app

# Copy dependency files and fetch packages
COPY go.mod go.sum ./
RUN go mod download

# Copy the server source code
COPY main.go ./

# Compile Go code statically for production Linux
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main .

# Stage 2: Create the final lightweight container
FROM alpine:latest

# Install base certificates for secure network calls
RUN apk --no-cache add ca-certificates

WORKDIR /app

# Copy the compiled server binary from builder phase
COPY --from=builder /app/main .

# Copy the static web frontend assets folder (contains html, css, js, icons)
COPY static/ ./static/

# Expose HTTP port 8080
EXPOSE 8080

# Execute server binary
ENTRYPOINT ["./main"]
