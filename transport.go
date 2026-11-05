package cerium

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// newHTTPClient applies the optional upstream egress proxy. Service calls opt
// out entirely, including environment proxies. Redirects never replay credentials.
func newHTTPClient(timeout time.Duration, direct bool) (*http.Client, error) {
	transport := http.DefaultTransport
	if direct {
		configured := http.DefaultTransport.(*http.Transport).Clone()
		configured.Proxy = nil
		transport = configured
	} else if raw := strings.TrimSpace(os.Getenv("CERIUM_OUTBOUND_PROXY_URL")); raw != "" {
		proxy, err := url.Parse(raw)
		if err != nil || proxy.Hostname() == "" || (proxy.Scheme != "http" && proxy.Scheme != "https") ||
			(proxy.Path != "" && proxy.Path != "/") || proxy.RawQuery != "" || proxy.Fragment != "" {
			return nil, errors.New("CERIUM_OUTBOUND_PROXY_URL must be an HTTP(S) proxy origin")
		}
		configured := http.DefaultTransport.(*http.Transport).Clone()
		configured.Proxy = func(req *http.Request) (*url.URL, error) {
			host := strings.ToLower(req.URL.Hostname())
			if host == "localhost" || strings.HasSuffix(host, ".localhost") || net.ParseIP(host).IsLoopback() {
				return nil, nil
			}
			return proxy, nil
		}
		transport = configured
	}
	return &http.Client{
		Timeout:       timeout,
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, nil
}
