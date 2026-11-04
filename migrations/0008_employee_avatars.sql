-- Employee photographs. The image bytes live in the private R2 bucket (binding AVATARS); D1 keeps only this metadata,
-- one row per employee. Object keys are versioned and unguessable: employees/{company}/{employee}/avatar/{uuid}.{ext}
-- Additive only: no existing table or row is changed.
CREATE TABLE employee_avatars (
  employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);
