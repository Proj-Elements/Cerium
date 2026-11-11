package contracts

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

var definitions = func() map[string]any {
	var schema map[string]any
	if err := json.Unmarshal([]byte(wireSchema), &schema); err != nil {
		panic(err)
	}
	return schema["$defs"].(map[string]any)
}()

func Validate(name string, value any) error {
	definition, exists := definitions[name]
	if !exists {
		return fmt.Errorf("unknown wire contract %s", name)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("invalid wire contract at %s", name)
	}
	var decoded any
	if json.Unmarshal(encoded, &decoded) != nil {
		return fmt.Errorf("invalid wire contract at %s", name)
	}
	return validate(definition.(map[string]any), decoded, name)
}

func validate(schema map[string]any, value any, location string) error {
	fail := func() error { return fmt.Errorf("invalid wire contract at %s", location) }
	if reference, ok := schema["$ref"].(string); ok {
		segments := strings.Split(reference, "/")
		if err := validate(definitions[segments[len(segments)-1]].(map[string]any), value, location); err != nil {
			return err
		}
	}
	if branches, ok := schema["allOf"].([]any); ok {
		for _, branch := range branches {
			if err := validate(branch.(map[string]any), value, location); err != nil {
				return err
			}
		}
	}
	if required, ok := schema["required"].([]any); ok {
		object, objectOK := value.(map[string]any)
		if !objectOK {
			return fail()
		}
		for _, key := range required {
			if _, exists := object[key.(string)]; !exists {
				return fail()
			}
		}
	}
	types, exists := schema["type"]
	if !exists {
		return nil
	}
	kinds, ok := types.([]any)
	if !ok {
		kinds = []any{types}
	}
	kind := "null"
	switch value.(type) {
	case string:
		kind = "string"
	case bool:
		kind = "boolean"
	case float64:
		kind = "number"
	case []any:
		kind = "array"
	case map[string]any:
		kind = "object"
	}
	matched := false
	for _, candidate := range kinds {
		if candidate == kind || candidate == "integer" && kind == "number" && math.Trunc(value.(float64)) == value.(float64) && math.Abs(value.(float64)) <= 9007199254740991 {
			matched = true
		}
	}
	if !matched {
		return fail()
	}
	if allowed, ok := schema["enum"].([]any); ok {
		matched = false
		for _, candidate := range allowed {
			matched = matched || reflect.DeepEqual(candidate, value)
		}
		if !matched {
			return fail()
		}
	}
	tooLarge := func(key string, actual int) bool {
		bound, exists := schema[key].(float64)
		return exists && float64(actual) > bound
	}
	switch actual := value.(type) {
	case string:
		if minimum, ok := schema["minLength"].(float64); ok && (utf8.RuneCountInString(actual) < int(minimum) || strings.TrimSpace(actual) == "") {
			return fail()
		}
		if tooLarge("maxLength", utf8.RuneCountInString(actual)) || tooLarge("x-maxUtf16Length", len(utf16.Encode([]rune(actual)))) {
			return fail()
		}
		if schema["format"] == "date-time" {
			if _, err := time.Parse(time.RFC3339Nano, actual); err != nil {
				return fail()
			}
		}
	case float64:
		if math.IsNaN(actual) || math.IsInf(actual, 0) {
			return fail()
		}
		if minimum, ok := schema["minimum"].(float64); ok && actual < minimum {
			return fail()
		}
		if maximum, ok := schema["maximum"].(float64); ok && actual > maximum {
			return fail()
		}
	case []any:
		if tooLarge("maxItems", len(actual)) {
			return fail()
		}
		for index, entry := range actual {
			if err := validate(schema["items"].(map[string]any), entry, fmt.Sprintf("%s[%d]", location, index)); err != nil {
				return err
			}
		}
	case map[string]any:
		properties, _ := schema["properties"].(map[string]any)
		for key, child := range properties {
			if entry, exists := actual[key]; exists {
				if err := validate(child.(map[string]any), entry, location+"."+key); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
