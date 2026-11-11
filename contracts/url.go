package contracts

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"unicode/utf16"
)

func CanonicalSiteURL(raw string) (string, error) {
	invalid := errors.New("invalid site URL")
	if len(utf16.Encode([]rune(raw))) > 2048 || strings.ContainsAny(raw, "\\\r\n\t") {
		return "", invalid
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || strings.Contains(raw, "#") || parsed.Opaque != "" || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", invalid
	}
	host, port := strings.ToLower(parsed.Hostname()), parsed.Port()
	if port == "80" && parsed.Scheme == "http" || port == "443" && parsed.Scheme == "https" {
		port = ""
	}
	parsed.Host = host
	if port != "" {
		parsed.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		parsed.Host = "[" + host + "]"
	}
	segments := strings.Split(parsed.EscapedPath(), "/")
	clean := make([]string, 0, len(segments))
	for _, segment := range segments {
		decoded, err := url.PathUnescape(segment)
		if err != nil {
			return "", invalid
		}
		if decoded == "." {
			continue
		}
		if decoded == ".." {
			if len(clean) > 1 {
				clean = clean[:len(clean)-1]
			}
			continue
		}
		clean = append(clean, segment)
	}
	escaped := strings.TrimRight(strings.Join(clean, "/"), "/")
	parsed.Path, err = url.PathUnescape(escaped)
	if err != nil {
		return "", invalid
	}
	parsed.RawPath = escaped
	return parsed.String(), nil
}
