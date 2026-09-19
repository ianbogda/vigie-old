CREATE TABLE IF NOT EXISTS ygpie1_snapshots (
  id BIGSERIAL PRIMARY KEY,
  opale_entity TEXT NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source_filename TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ygpie1_snapshots_entity ON ygpie1_snapshots(opale_entity, created_at DESC);

CREATE TABLE IF NOT EXISTS ygpie1_pieces (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES ygpie1_snapshots(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  piece TEXT, installment TEXT, piece_type TEXT, due_date DATE,
  account TEXT, main_party TEXT,
  debit_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
  credit_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
  debit_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  credit_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  opale_entity TEXT, state TEXT, reference TEXT, label TEXT,
  movement_type TEXT, entry_no TEXT, initial_due_date DATE, value_date DATE,
  party TEXT, balance_indicator TEXT, settlement_date DATE,
  created_source_date DATE, modified_source_date DATE,
  raw_data JSONB
);
CREATE INDEX IF NOT EXISTS idx_ygpie1_pieces_snapshot ON ygpie1_pieces(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_ygpie1_pieces_account ON ygpie1_pieces(snapshot_id, account);
CREATE INDEX IF NOT EXISTS idx_ygpie1_pieces_due ON ygpie1_pieces(snapshot_id, due_date);
