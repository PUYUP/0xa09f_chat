package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// hub fans live events out to every open app (Server-Sent Events). Each
// open app is one subscriber with a buffered channel; a slow app loses
// events rather than slowing anybody else down.
type hub struct {
	mu       sync.RWMutex
	subs     map[string]map[*subscriber]struct{} // user -> open apps
	onlineT  *time.Timer
	lastGone func(user string) // called when a user's last app closes
	closed   chan struct{}
}

type subscriber struct {
	ch chan []byte
}

func newHub() *hub {
	return &hub{subs: map[string]map[*subscriber]struct{}{}, closed: make(chan struct{})}
}

func frame(event string, data any) []byte {
	b, err := json.Marshal(data)
	if err != nil {
		b = []byte("{}")
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
}

func (h *hub) subscribe(user string) *subscriber {
	s := &subscriber{ch: make(chan []byte, 256)}
	h.mu.Lock()
	if h.subs[user] == nil {
		h.subs[user] = map[*subscriber]struct{}{}
	}
	h.subs[user][s] = struct{}{}
	h.mu.Unlock()
	h.onlineChanged()
	return s
}

func (h *hub) unsubscribe(user string, s *subscriber) {
	h.mu.Lock()
	gone := false
	if set := h.subs[user]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(h.subs, user)
			gone = true
		}
	}
	h.mu.Unlock()
	if gone && h.lastGone != nil {
		h.lastGone(user)
	}
	h.onlineChanged()
}

func (h *hub) send(user string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs[user] {
		select {
		case s.ch <- msg:
		default: // full: that app is too slow, drop
		}
	}
}

// push sends an event to every open app of one user.
func (h *hub) push(user, event string, data any) { h.send(user, frame(event, data)) }

// pushMany sends one event to several users (each once).
func (h *hub) pushMany(users []string, event string, data any) {
	msg := frame(event, data)
	seen := map[string]bool{}
	for _, u := range users {
		if !seen[u] {
			seen[u] = true
			h.send(u, msg)
		}
	}
}

// pushAll sends an event to everyone with a09f open.
func (h *hub) pushAll(event string, data any) {
	msg := frame(event, data)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, set := range h.subs {
		for s := range set {
			select {
			case s.ch <- msg:
			default:
			}
		}
	}
}

func (h *hub) listening(user string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[user]) > 0
}

// onlineUsers is a snapshot of who has a09f open.
func (h *hub) onlineUsers() map[string]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[string]bool, len(h.subs))
	for u := range h.subs {
		out[u] = true
	}
	return out
}

func (h *hub) onlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}

// onlineChanged tells everyone how many people have a09f open (debounced 2 s).
func (h *hub) onlineChanged() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.onlineT != nil {
		return
	}
	h.onlineT = time.AfterFunc(2*time.Second, func() {
		h.mu.Lock()
		h.onlineT = nil
		h.mu.Unlock()
		h.pushAll("online", obj{"count": h.onlineCount()})
	})
}

func (h *hub) closeAll() {
	select {
	case <-h.closed:
	default:
		close(h.closed)
	}
}

// serve streams events to one app until it disconnects.
func (h *hub) serve(w http.ResponseWriter, r *http.Request, user string) {
	s := h.subscribe(user)
	defer h.unsubscribe(user, s)
	rc := http.NewResponseController(w)
	hd := w.Header()
	hd.Set("Content-Type", "text/event-stream")
	hd.Set("Cache-Control", "no-cache")
	hd.Set("X-Accel-Buffering", "no")
	cors(w)
	w.WriteHeader(200)
	write := func(b []byte) bool {
		rc.SetWriteDeadline(time.Now().Add(20 * time.Second))
		if _, err := w.Write(b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	if !write([]byte(": connected\n\n")) {
		return
	}
	keep := time.NewTicker(25 * time.Second) // also detects dead connections
	defer keep.Stop()
	for {
		select {
		case msg := <-s.ch:
			if !write(msg) {
				return
			}
		case <-keep.C:
			if !write([]byte(": keepalive\n\n")) {
				return
			}
		case <-r.Context().Done():
			return
		case <-h.closed:
			return
		}
	}
}
