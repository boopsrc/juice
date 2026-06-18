package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536 // Increased to support large WebRTC SDP messages safely
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow cross-origin for local development/testing
	},
}

// Message represents a generic WebSocket wrapper
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// WelcomePayload is sent to the client upon connection
type WelcomePayload struct {
	ID      string             `json:"id"`
	Players map[string]*Player `json:"players"`
}

// JoinPayload is sent when a player joins the map
type JoinPayload struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Color    string  `json:"color"`
	ImageURL string  `json:"imageUrl"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

// MovePayload is sent when a player changes position
type MovePayload struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

// ChatPayload is sent when a player posts a chat message
type ChatPayload struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

// SignalPayload is routed between clients for WebRTC signaling
type SignalPayload struct {
	To     string          `json:"to"`
	From   string          `json:"from"`
	Signal json.RawMessage `json:"signal"`
}

// Player represents a game character's state in memory
type Player struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Color    string  `json:"color"`
	ImageURL string  `json:"imageUrl"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

// ClientMessage wraps raw bytes with the sending Client's pointer
type ClientMessage struct {
	client  *Client
	message []byte
}

// Client represents a single connected user
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
	id   string
}

// Hub manages active connections and client synchronization
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan ClientMessage
	register   chan *Client
	unregister chan *Client
	players    map[string]*Player
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan ClientMessage),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		players:    make(map[string]*Player),
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = true
			
			welcomePayload := WelcomePayload{
				ID:      client.id,
				Players: h.players,
			}
			welcomePayloadJSON, err := json.Marshal(welcomePayload)
			if err != nil {
				log.Printf("error marshaling welcome payload: %v", err)
				continue
			}

			welcomeMsg := Message{
				Type:    "welcome",
				Payload: json.RawMessage(welcomePayloadJSON),
			}
			welcomeMsgBytes, err := json.Marshal(welcomeMsg)
			if err != nil {
				log.Printf("error marshaling welcome message: %v", err)
				continue
			}

			client.send <- welcomeMsgBytes

		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				
				// Delete player state from memory and notify others
				if _, exists := h.players[client.id]; exists {
					delete(h.players, client.id)
					
					leavePayload := struct {
						ID string `json:"id"`
					}{ID: client.id}
					
					leavePayloadJSON, _ := json.Marshal(leavePayload)
					leaveMsg := Message{
						Type:    "leave",
						Payload: json.RawMessage(leavePayloadJSON),
					}
					leaveMsgBytes, _ := json.Marshal(leaveMsg)
					h.broadcastToAll(leaveMsgBytes)
				}
			}

		case cm := <-h.broadcast:
			var msg Message
			if err := json.Unmarshal(cm.message, &msg); err != nil {
				log.Printf("error unmarshaling incoming message: %v", err)
				continue
			}

			switch msg.Type {
			case "join":
				var payload JoinPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("error unmarshaling join payload: %v", err)
					continue
				}
				// Force server-generated client ID to prevent impersonation
				payload.ID = cm.client.id
				
				h.players[payload.ID] = &Player{
					ID:       payload.ID,
					Name:     payload.Name,
					Color:    payload.Color,
					ImageURL: payload.ImageURL,
					X:        payload.X,
					Y:        payload.Y,
				}

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes)

			case "move":
				var payload MovePayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("error unmarshaling move payload: %v", err)
					continue
				}
				payload.ID = cm.client.id

				if player, exists := h.players[payload.ID]; exists {
					player.X = payload.X
					player.Y = payload.Y
				} else {
					continue // Ignore updates for players not fully registered/joined
				}

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes)

			case "chat":
				var payload ChatPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("error unmarshaling chat payload: %v", err)
					continue
				}
				payload.ID = cm.client.id

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes)

			case "signal":
				var payload SignalPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("error unmarshaling signal payload: %v", err)
					continue
				}
				// Force sender ID to ensure signaling integrity
				payload.From = cm.client.id

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				// Dispatch directly to the recipient client
				for client := range h.clients {
					if client.id == payload.To {
						select {
						case client.send <- newMsgBytes:
						default:
							client.conn.Close()
						}
						break
					}
				}
			}
		}
	}
}

func (h *Hub) broadcastToAll(message []byte) {
	for client := range h.clients {
		select {
		case client.send <- message:
		default:
			client.conn.Close()
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket read error: %v", err)
			}
			break
		}
		c.hub.broadcast <- ClientMessage{client: c, message: message}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func generateID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("failed to upgrade connection: %v", err)
		return
	}
	client := &Client{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 256),
		id:   generateID(),
	}
	client.hub.register <- client

	go client.writePump()
	go client.readPump()
}

func main() {
	hub := newHub()
	go hub.run()

	// Serve frontend static files
	fileServer := http.FileServer(http.Dir("./static"))
	http.Handle("/", fileServer)

	// Serve websocket route
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	addr := ":8080"
	log.Printf("Starting multiplayer server on http://localhost%s ...", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("ListenAndServe error: %v", err)
	}
}
