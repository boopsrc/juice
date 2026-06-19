package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// ============================================================
// Data Structures
// ============================================================

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type WelcomePayload struct {
	ID         string             `json:"id"`
	Players    map[string]*Player `json:"players"`
	RoomID     string             `json:"roomId"`
	RoomName   string             `json:"roomName"`
	CurrentMap int                `json:"currentMap"`
}

type JoinPayload struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Color    string  `json:"color"`
	ImageURL string  `json:"imageUrl"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	HP       int     `json:"hp"`
}

type MovePayload struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

type ChatPayload struct {
	ID      string `json:"id"`
	Message string `json:"message"`
}

type PingPayload struct {
	Timestamp int64 `json:"timestamp"`
}

type UpdatePingPayload struct {
	ID   string `json:"id"`
	Ping int    `json:"ping"`
}

type ChangeMapPayload struct {
	MapID int `json:"mapId"`
}

type SignalPayload struct {
	To     string          `json:"to"`
	From   string          `json:"from"`
	Signal json.RawMessage `json:"signal"`
}

type Player struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Color    string  `json:"color"`
	ImageURL string  `json:"imageUrl"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Ping     int     `json:"ping"`
	HP       int     `json:"hp"`
}

type ClientMessage struct {
	client  *Client
	message []byte
}

type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
	id   string
}

// ============================================================
// Hub — one per room
// ============================================================

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan ClientMessage
	register   chan *Client
	unregister chan *Client
	players    map[string]*Player
	room       *Room // back-pointer to the owning room
}

func newHub(room *Room) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan ClientMessage),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		players:    make(map[string]*Player),
		room:       room,
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = true

			welcomePayload := WelcomePayload{
				ID:         client.id,
				Players:    h.players,
				RoomID:     h.room.ID,
				RoomName:   h.room.Name,
				CurrentMap: h.room.CurrentMap,
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
					h.broadcastToAll(leaveMsgBytes, true)
				}

				// If room is now empty, schedule cleanup
				if len(h.clients) == 0 && h.room != nil {
					go h.room.manager.scheduleCleanup(h.room.ID)
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
				payload.ID = cm.client.id

				h.players[payload.ID] = &Player{
					ID:       payload.ID,
					Name:     payload.Name,
					Color:    payload.Color,
					ImageURL: payload.ImageURL,
					X:        payload.X,
					Y:        payload.Y,
					HP:       payload.HP,
				}

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes, true)

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
					continue
				}

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes, false)

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

				h.broadcastToAll(newMsgBytes, true)

			case "signal":
				var payload SignalPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("error unmarshaling signal payload: %v", err)
					continue
				}
				payload.From = cm.client.id

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

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

			case "change_map":
				var payload ChangeMapPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					continue
				}

				if h.room != nil {
					h.room.manager.mu.Lock()
					h.room.CurrentMap = payload.MapID
					h.room.manager.mu.Unlock()
				}

				h.broadcastToAll(cm.message, true) // Broadcast unchanged to everyone

			case "ping":
				// Echo directly back to the sender
				var payload PingPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					continue
				}
				
				pongMsg := Message{
					Type:    "pong",
					Payload: msg.Payload,
				}
				pongBytes, _ := json.Marshal(pongMsg)

				select {
				case cm.client.send <- pongBytes:
				default:
					cm.client.conn.Close()
				}

			case "update_ping":
				var payload UpdatePingPayload
				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					continue
				}
				payload.ID = cm.client.id

				if player, exists := h.players[payload.ID]; exists {
					player.Ping = payload.Ping
				}

				newPayloadBytes, _ := json.Marshal(payload)
				msg.Payload = json.RawMessage(newPayloadBytes)
				newMsgBytes, _ := json.Marshal(msg)

				h.broadcastToAll(newMsgBytes, false)

			case "update_hp":
				var payload struct {
					ID string `json:"id"`
					HP int    `json:"hp"`
				}
				if err := json.Unmarshal(msg.Payload, &payload); err == nil {
					payload.ID = cm.client.id
					if player, exists := h.players[payload.ID]; exists {
						player.HP = payload.HP
					}
					newPayloadBytes, _ := json.Marshal(payload)
					msg.Payload = json.RawMessage(newPayloadBytes)
					newMsgBytes, _ := json.Marshal(msg)
					h.broadcastToAll(newMsgBytes, true)
				}

			case "new_drawing", "shoot", "death":
				h.broadcastToAll(cm.message, true)
			}
		}
	}
}

func (h *Hub) broadcastToAll(message []byte, priority bool) {
	for client := range h.clients {
		select {
		case client.send <- message:
		default:
			if !priority {
				continue
			}
			client.conn.Close()
		}
	}
}

func (h *Hub) playerCount() int {
	return len(h.clients)
}

// ============================================================
// Room
// ============================================================

type Room struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	IsPrivate  bool         `json:"isPrivate"`
	Password   string       `json:"-"` // never exposed via JSON
	CreatedAt  time.Time    `json:"createdAt"`
	CurrentMap int          `json:"currentMap"`
	Hub        *Hub         `json:"-"`
	manager    *RoomManager // back-pointer
}

// RoomInfo is the public JSON representation for the API
type RoomInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	IsPrivate   bool   `json:"isPrivate"`
	PlayerCount int    `json:"playerCount"`
}

// ============================================================
// RoomManager — thread-safe room registry
// ============================================================

type RoomManager struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func newRoomManager() *RoomManager {
	return &RoomManager{
		rooms: make(map[string]*Room),
	}
}

func (rm *RoomManager) CreateRoom(name string, isPrivate bool, password string) *Room {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	id := generateID()
	room := &Room{
		ID:         id,
		Name:       name,
		IsPrivate:  isPrivate,
		Password:   password,
		CreatedAt:  time.Now(),
		CurrentMap: 0, // default map
		manager:    rm,
	}
	room.Hub = newHub(room)
	go room.Hub.run()

	rm.rooms[id] = room
	log.Printf("[RoomManager] Room created: %s (%s) private=%v", name, id, isPrivate)
	return room
}

func (rm *RoomManager) GetRoom(id string) *Room {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.rooms[id]
}

func (rm *RoomManager) ListRooms() []RoomInfo {
	rm.mu.RLock()
	defer rm.mu.RUnlock()

	list := make([]RoomInfo, 0, len(rm.rooms))
	for _, room := range rm.rooms {
		list = append(list, RoomInfo{
			ID:          room.ID,
			Name:        room.Name,
			IsPrivate:   room.IsPrivate,
			PlayerCount: room.Hub.playerCount(),
		})
	}
	return list
}

func (rm *RoomManager) scheduleCleanup(roomID string) {
	// Wait 30 seconds then check if room is still empty
	time.Sleep(30 * time.Second)

	rm.mu.Lock()
	defer rm.mu.Unlock()

	room, exists := rm.rooms[roomID]
	if !exists {
		return
	}

	if room.Hub.playerCount() == 0 {
		delete(rm.rooms, roomID)
		log.Printf("[RoomManager] Room cleaned up (empty): %s (%s)", room.Name, roomID)
	}
}

// ============================================================
// Client pumps
// ============================================================

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

// ============================================================
// Helpers
// ============================================================

func generateID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// ============================================================
// HTTP Handlers
// ============================================================

func serveWs(rm *RoomManager, w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	pwd := r.URL.Query().Get("pwd")

	if roomID == "" {
		http.Error(w, "missing room query parameter", http.StatusBadRequest)
		return
	}

	room := rm.GetRoom(roomID)
	if room == nil {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	// Validate password for private rooms
	if room.IsPrivate && room.Password != "" {
		if pwd != room.Password {
			http.Error(w, "invalid password", http.StatusForbidden)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("failed to upgrade connection: %v", err)
		return
	}
	client := &Client{
		hub:  room.Hub,
		conn: conn,
		send: make(chan []byte, 256),
		id:   generateID(),
	}
	client.hub.register <- client

	go client.writePump()
	go client.readPump()
}

func handleCreateRoom(rm *RoomManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			Name      string `json:"name"`
			IsPrivate bool   `json:"isPrivate"`
			Password  string `json:"password"`
		}

		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		name := strings.TrimSpace(req.Name)
		if name == "" {
			name = "Sala sem nome"
		}
		if len(name) > 30 {
			name = name[:30]
		}

		password := ""
		if req.IsPrivate {
			password = strings.TrimSpace(req.Password)
		}

		room := rm.CreateRoom(name, req.IsPrivate, password)

		resp := struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			IsPrivate bool   `json:"isPrivate"`
		}{
			ID:        room.ID,
			Name:      room.Name,
			IsPrivate: room.IsPrivate,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func handleListRooms(rm *RoomManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		rooms := rm.ListRooms()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rooms)
	}
}

// ============================================================
// Main
// ============================================================

func main() {
	rm := newRoomManager()

	// Serve frontend static files
	fileServer := http.FileServer(http.Dir("./static"))
	http.Handle("/", fileServer)

	// API endpoints
	http.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleListRooms(rm)(w, r)
		case http.MethodPost:
			handleCreateRoom(rm)(w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	http.HandleFunc("/api/players/count", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		total := 0
		rm.mu.RLock()
		for _, room := range rm.rooms {
			total += room.Hub.playerCount()
		}
		rm.mu.RUnlock()

		resp := struct {
			Count int `json:"count"`
		}{
			Count: total,
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	// WebSocket endpoint — requires ?room=ROOM_ID
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(rm, w, r)
	})

	addr := ":8080"
	log.Printf("Starting NeonGrid server on http://localhost%s ...", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("ListenAndServe error: %v", err)
	}
}
