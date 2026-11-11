export const wireSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://cerium.local/contracts/wire.schema.json",
  "$defs": {
    "ModelPrice": {
      "type": "object",
      "required": [
        "model",
        "mode"
      ],
      "properties": {
        "model": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300,
          "x-maxUtf16Length": 300
        },
        "mode": {
          "type": "string",
          "enum": [
            "tokens",
            "request",
            "dynamic",
            "unknown"
          ]
        },
        "input": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "output": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "cache_read": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "cache_write": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "request": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "expression": {
          "type": "string",
          "maxLength": 16000,
          "x-maxUtf16Length": 16000
        }
      }
    },
    "Group": {
      "type": "object",
      "required": [
        "id",
        "name",
        "multiplier",
        "models_known",
        "models"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "x-maxUtf16Length": 200,
          "x-goName": "ID"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "x-maxUtf16Length": 200
        },
        "description": {
          "type": "string",
          "maxLength": 2000,
          "x-maxUtf16Length": 2000
        },
        "platform": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100
        },
        "multiplier": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000
        },
        "default_multiplier": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1000000000000,
          "x-goOmitEmpty": false
        },
        "multiplier_source": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100,
          "x-goOmitEmpty": false
        },
        "models": {
          "type": [
            "array",
            "null"
          ],
          "maxItems": 10000,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300,
            "x-maxUtf16Length": 300
          },
          "x-tsType": "string[]"
        },
        "models_known": {
          "type": "boolean"
        },
        "models_source": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100
        },
        "models_fetched_at": {
          "type": "string",
          "maxLength": 64,
          "x-maxUtf16Length": 64
        },
        "prices": {
          "type": [
            "array",
            "null"
          ],
          "maxItems": 10000,
          "items": {
            "$ref": "#/$defs/ModelPrice"
          },
          "x-tsType": "Price[]"
        }
      }
    },
    "Catalog": {
      "type": "object",
      "required": [
        "groups"
      ],
      "properties": {
        "groups": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "$ref": "#/$defs/Group"
          }
        },
        "warnings": {
          "type": [
            "array",
            "null"
          ],
          "maxItems": 1000,
          "items": {
            "type": "string",
            "maxLength": 2000,
            "x-maxUtf16Length": 2000
          }
        },
        "scope": {
          "type": "string",
          "enum": [
            "",
            "public",
            "private",
            "manual"
          ],
          "x-tsRequired": true
        }
      }
    },
    "BridgeJob": {
      "type": "object",
      "required": [
        "job_id",
        "site_id",
        "config_revision",
        "operation",
        "name",
        "url",
        "type",
        "account",
        "password"
      ],
      "properties": {
        "job_id": {
          "type": "string",
          "minLength": 16,
          "maxLength": 128,
          "x-maxUtf16Length": 128,
          "x-goName": "JobID"
        },
        "site_id": {
          "type": "string",
          "minLength": 16,
          "maxLength": 128,
          "x-maxUtf16Length": 128,
          "x-goName": "SiteID"
        },
        "config_revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991,
          "x-goName": "Revision"
        },
        "operation": {
          "type": "string",
          "enum": [
            "sync",
            "delete"
          ]
        },
        "name": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100
        },
        "url": {
          "type": "string",
          "maxLength": 2048,
          "x-maxUtf16Length": 2048,
          "x-goName": "URL"
        },
        "type": {
          "type": "string",
          "enum": [
            "newapi",
            "sub2api",
            "others"
          ]
        },
        "account": {
          "type": "string",
          "maxLength": 320,
          "x-maxUtf16Length": 320
        },
        "password": {
          "type": "string",
          "maxLength": 4096,
          "x-maxUtf16Length": 4096
        },
        "access_token": {
          "type": "string",
          "maxLength": 16384,
          "x-maxUtf16Length": 16384
        },
        "user_id": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991,
          "x-goName": "UserID"
        },
        "refresh_models": {
          "type": "boolean"
        }
      }
    },
    "SyncResult": {
      "x-goName": "Result",
      "type": "object",
      "required": [
        "url",
        "type",
        "checked_at"
      ],
      "properties": {
        "credential_id": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991,
          "x-goName": "CredentialID",
          "x-goOmitEmpty": false
        },
        "name": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100,
          "x-goOmitEmpty": false
        },
        "url": {
          "type": "string",
          "maxLength": 2048,
          "x-maxUtf16Length": 2048,
          "x-goName": "URL"
        },
        "type": {
          "type": "string",
          "enum": [
            "newapi",
            "sub2api",
            "others"
          ]
        },
        "checked_at": {
          "type": "string",
          "format": "date-time",
          "x-goType": "time.Time"
        },
        "refresh": {
          "type": "string",
          "maxLength": 100,
          "x-maxUtf16Length": 100,
          "x-goOmitEmpty": false
        },
        "catalog": {
          "$ref": "#/$defs/Catalog",
          "x-goPointer": true
        },
        "warnings": {
          "type": [
            "array",
            "null"
          ],
          "maxItems": 1000,
          "items": {
            "type": "string",
            "maxLength": 2000,
            "x-maxUtf16Length": 2000
          }
        },
        "error": {
          "type": "string",
          "maxLength": 2000,
          "x-maxUtf16Length": 2000
        },
        "error_stage": {
          "type": "string",
          "maxLength": 64,
          "x-maxUtf16Length": 64
        },
        "error_category": {
          "type": "string",
          "maxLength": 64,
          "x-maxUtf16Length": 64
        },
        "site_id": {
          "type": "string",
          "minLength": 16,
          "maxLength": 128,
          "x-maxUtf16Length": 128,
          "x-goName": "SiteID"
        },
        "job_id": {
          "type": "string",
          "minLength": 16,
          "maxLength": 128,
          "x-maxUtf16Length": 128,
          "x-goName": "JobID"
        },
        "config_revision": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        }
      }
    },
    "BridgeIdentity": {
      "x-validateOnly": true,
      "type": "object",
      "required": [
        "site_id",
        "job_id",
        "config_revision"
      ],
      "properties": {
        "site_id": {
          "$ref": "#/$defs/SyncResult/properties/site_id"
        },
        "job_id": {
          "$ref": "#/$defs/SyncResult/properties/job_id"
        },
        "config_revision": {
          "$ref": "#/$defs/SyncResult/properties/config_revision"
        }
      }
    },
    "BridgeResult": {
      "x-validateOnly": true,
      "allOf": [
        {
          "$ref": "#/$defs/SyncResult"
        },
        {
          "$ref": "#/$defs/BridgeIdentity"
        }
      ]
    }
  }
};

export class ContractError extends Error {
  constructor(path) {
    super(`Invalid wire contract at ${path}`);
    this.name = "ContractError";
  }
}

export function assertWireContract(name, value) {
  const definition = wireSchema.$defs[name];
  if (!definition) throw new Error(`Unknown wire contract ${name}`);
  validate(definition, value, name);
  return value;
}

export function canonicalSiteURL(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.trim() || /[\\\r\n\t]|%(?![0-9a-f]{2})/i.test(value)) throw new ContractError("site.url");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new ContractError("site.url"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || value.trim().includes("?") || value.trim().includes("#")) throw new ContractError("site.url");
  return parsed.href.replace(/\|/g, "%7C").replace(/\/+$/, "");
}

function validate(schema, value, path) {
  const fail = () => { throw new ContractError(path); };
  if (schema.$ref) validate(schema.$ref.slice(2).split("/").reduce((object, key) => object[key], wireSchema), value, path);
  for (const branch of schema.allOf ?? []) validate(branch, value, path);
  for (const key of schema.required ?? []) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) fail();
  }
  if (!schema.type) return;
  const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!kinds.includes(kind) && !(kind === "number" && kinds.includes("integer") && Number.isSafeInteger(value))) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (kind === "string") {
    const length = Array.from(value).length;
    if ((schema.minLength !== undefined && (length < schema.minLength || !value.trim())) ||
        (schema.maxLength !== undefined && length > schema.maxLength) ||
        (schema["x-maxUtf16Length"] !== undefined && value.length > schema["x-maxUtf16Length"])) fail();
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) fail();
  } else if (kind === "number") {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum)) fail();
  } else if (kind === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail();
    value.forEach((entry, index) => validate(schema.items, entry, `${path}[${index}]`));
  } else if (kind === "object") {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
  }
}
