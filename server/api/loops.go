package main

import (
	"context"
	"log"
	"time"
)

// backgroundLoop runs every 10 seconds: reminders for people with a09f open
// (the rest get them from /reminders/due at sign-in), disappearing messages,
// "event starts soon", scheduled messages, and housekeeping.
func (s *server) backgroundLoop(ctx context.Context) {
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("background loop: %v", r)
				}
			}()
			if due, err := s.dueReminders(ctx, ""); err == nil {
				var sent []reminder
				for _, r := range due {
					if s.hub.listening(r.User) {
						s.hub.push(r.User, "reminder", r)
						sent = append(sent, r)
					}
				}
				s.markDelivered(ctx, sent)
			}
			s.expireDue(ctx)
			s.eventsStarting(ctx)
			s.sendScheduled(ctx)
			if n++; n%60 == 0 { // every 10 minutes
				for _, l := range []*limiter{s.attempts, s.creates, s.logins, s.previews} {
					l.sweep()
				}
				s.sess.sweep()
				s.db.Exec(ctx, `DELETE FROM sessions WHERE expires < $1 OR last < $2`, now(), now()-sessionIdle)
			}
		}()
	}
}
