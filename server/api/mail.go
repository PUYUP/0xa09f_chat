package main

import (
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

// sendMail sends a plain-text email through SMTP_HOST (SMTP_SECURITY:
// starttls | ssl | none).
func (s *server) sendMail(to, subject, body string) error {
	c := s.cfg
	if c.smtpHost == "" {
		return errors.New("SMTP_HOST is not configured")
	}
	from, err := mail.ParseAddress(c.mailFrom)
	if err != nil {
		return fmt.Errorf("MAIL_FROM: %w", err)
	}
	addr := net.JoinHostPort(c.smtpHost, c.smtpPort)
	var conn net.Conn
	dialer := &net.Dialer{Timeout: 20 * time.Second}
	if c.smtpSecurity == "ssl" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: c.smtpHost})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return err
	}
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	cl, err := smtp.NewClient(conn, c.smtpHost)
	if err != nil {
		conn.Close()
		return err
	}
	defer cl.Close()
	if c.smtpSecurity == "starttls" {
		if err := cl.StartTLS(&tls.Config{ServerName: c.smtpHost}); err != nil {
			return err
		}
	}
	if c.smtpUser != "" {
		if err := cl.Auth(smtp.PlainAuth("", c.smtpUser, c.smtpPassword, c.smtpHost)); err != nil {
			return err
		}
	}
	if err := cl.Mail(from.Address); err != nil {
		return err
	}
	if err := cl.Rcpt(to); err != nil {
		return err
	}
	w, err := cl.Data()
	if err != nil {
		return err
	}
	clean := func(h string) string { return strings.NewReplacer("\r", "", "\n", "").Replace(h) }
	msg := "From: " + clean(c.mailFrom) + "\r\n" +
		"To: " + clean(to) + "\r\n" +
		"Subject: " + mime.QEncoding.Encode("utf-8", clean(subject)) + "\r\n" +
		"Date: " + time.Now().Format(time.RFC1123Z) + "\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" +
		strings.ReplaceAll(body, "\n", "\r\n")
	if _, err := w.Write([]byte(msg)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return cl.Quit()
}
