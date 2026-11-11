package contracts

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestContractFixtures(t *testing.T) {
	encoded, err := os.ReadFile("fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Bases map[string]json.RawMessage `json:"bases"`
		Cases []struct {
			Name        string          `json:"name"`
			Contract    string          `json:"contract"`
			Base        string          `json:"base"`
			Valid       bool            `json:"valid"`
			Path        []any           `json:"path"`
			Delete      bool            `json:"delete"`
			Value       any             `json:"value"`
			Repeat      *string         `json:"repeat"`
			ArrayRepeat json.RawMessage `json:"arrayRepeat"`
			Count       int             `json:"count"`
		} `json:"cases"`
		URLs []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
			Valid    *bool  `json:"valid"`
		} `json:"urls"`
	}
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			var value any
			if err := json.Unmarshal(fixtures.Bases[fixture.Base], &value); err != nil {
				t.Fatal(err)
			}
			if len(fixture.Path) > 0 {
				parent := value
				for _, key := range fixture.Path[:len(fixture.Path)-1] {
					if name, ok := key.(string); ok {
						parent = parent.(map[string]any)[name]
					} else {
						parent = parent.([]any)[int(key.(float64))]
					}
				}
				key := fixture.Path[len(fixture.Path)-1].(string)
				object := parent.(map[string]any)
				if fixture.Delete {
					delete(object, key)
				} else if fixture.Repeat != nil {
					object[key] = strings.Repeat(*fixture.Repeat, fixture.Count)
				} else if fixture.ArrayRepeat != nil {
					entries := make([]any, fixture.Count)
					for index := range entries {
						if err := json.Unmarshal(fixture.ArrayRepeat, &entries[index]); err != nil {
							t.Fatal(err)
						}
					}
					object[key] = entries
				} else {
					object[key] = fixture.Value
				}
			}
			if err := Validate(fixture.Contract, value); (err == nil) != fixture.Valid {
				t.Fatalf("valid=%v error=%v", fixture.Valid, err)
			}
		})
	}
	for _, fixture := range fixtures.URLs {
		t.Run("URL/"+fixture.Input, func(t *testing.T) {
			actual, err := CanonicalSiteURL(fixture.Input)
			if fixture.Valid != nil && !*fixture.Valid {
				if err == nil {
					t.Fatalf("expected invalid URL; got %q", actual)
				}
			} else if err != nil || actual != fixture.Expected {
				t.Fatalf("expected %q; got %q error=%v", fixture.Expected, actual, err)
			}
		})
	}
}
