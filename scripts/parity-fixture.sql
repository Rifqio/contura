-- Sample shop schema for the parity captures (Task 25).
-- Loads unchanged into MySQL 8 and PostgreSQL 13+ test databases
-- (dbview_test_<8hex>); run ANALYZE afterwards so row estimates are filled.
-- orders holds 20,000 rows so its estimate is over 10,000 (Explain flags
-- a full scan of it).

CREATE TABLE digits (d INT PRIMARY KEY);
INSERT INTO digits (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);

CREATE TABLE customers (
  id INT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(120) NOT NULL,
  city VARCHAR(60),
  created_at TIMESTAMP NULL
);

CREATE TABLE products (
  id INT PRIMARY KEY,
  sku VARCHAR(20) NOT NULL,
  name VARCHAR(80) NOT NULL,
  price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  total DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMP NULL,
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
  id INT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders (id),
  FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE invoices (
  id INT PRIMARY KEY,
  order_id INT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  status VARCHAR(20) NOT NULL,
  issued_at TIMESTAMP NULL,
  FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE payments (
  id INT PRIMARY KEY,
  invoice_id INT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  paid_at TIMESTAMP NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices (id)
);

CREATE TABLE shipments (
  id INT PRIMARY KEY,
  order_id INT NOT NULL,
  carrier VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL,
  picked_up_at TIMESTAMP NULL,
  promised_at TIMESTAMP NULL,
  delivered_at TIMESTAMP NULL,
  FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE shipment_events (
  id INT PRIMARY KEY,
  shipment_id INT NOT NULL,
  kind VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NULL,
  FOREIGN KEY (shipment_id) REFERENCES shipments (id)
);

INSERT INTO customers (id, name, email, city, created_at)
SELECT a.d + 10 * b.d + 100 * c.d + 1,
       CONCAT('Customer ', a.d + 10 * b.d + 100 * c.d + 1),
       CONCAT('customer', a.d + 10 * b.d + 100 * c.d + 1, '@example.com'),
       CASE a.d WHEN 0 THEN 'Jakarta' WHEN 1 THEN 'Bandung' WHEN 2 THEN 'Surabaya' WHEN 3 THEN 'Medan'
                WHEN 4 THEN 'Denpasar' WHEN 5 THEN 'Makassar' WHEN 6 THEN 'Semarang' ELSE 'Yogyakarta' END,
       CASE b.d WHEN 0 THEN TIMESTAMP '2025-01-14 09:12:00' WHEN 1 THEN TIMESTAMP '2025-03-02 10:40:00'
                WHEN 2 THEN TIMESTAMP '2025-05-21 14:05:00' ELSE TIMESTAMP '2025-08-09 16:30:00' END
FROM digits a, digits b, digits c;

INSERT INTO products (id, sku, name, price)
SELECT a.d + 10 * b.d + 1,
       CONCAT('SKU-', 1000 + a.d + 10 * b.d),
       CONCAT(CASE a.d WHEN 0 THEN 'Pallet wrap' WHEN 1 THEN 'Cold box' WHEN 2 THEN 'Label roll' WHEN 3 THEN 'Tape'
                       WHEN 4 THEN 'Crate' WHEN 5 THEN 'Sensor' WHEN 6 THEN 'Seal kit' ELSE 'Carton' END,
              ' ', b.d + 1),
       5 + a.d * 3 + b.d
FROM digits a, digits b;

INSERT INTO orders (id, customer_id, status, total, created_at)
SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 10000 * e.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1,
       CASE a.d WHEN 0 THEN 'pending' WHEN 1 THEN 'cancelled' WHEN 2 THEN 'paid' WHEN 3 THEN 'paid'
                WHEN 4 THEN 'shipped' ELSE 'delivered' END,
       12 + a.d * 7 + b.d * 3 + c.d,
       CASE d.d WHEN 0 THEN TIMESTAMP '2026-10-01 08:15:00' WHEN 1 THEN TIMESTAMP '2026-10-03 11:20:00'
                WHEN 2 THEN TIMESTAMP '2026-10-06 13:45:00' WHEN 3 THEN TIMESTAMP '2026-10-09 09:05:00'
                WHEN 4 THEN TIMESTAMP '2026-10-12 17:30:00' ELSE TIMESTAMP '2026-10-15 10:10:00' END
FROM digits a, digits b, digits c, digits d, digits e
WHERE e.d < 2;

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price)
SELECT 3 * (a.d + 10 * b.d + 100 * c.d + 1000 * d.d) + e.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       a.d + 10 * e.d + 1,
       1 + b.d,
       5 + a.d * 3 + e.d
FROM digits a, digits b, digits c, digits d, digits e
WHERE e.d < 3;

INSERT INTO invoices (id, order_id, amount, status, issued_at)
SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       12 + a.d * 7 + b.d * 3 + c.d,
       CASE a.d WHEN 0 THEN 'open' WHEN 1 THEN 'void' ELSE 'paid' END,
       TIMESTAMP '2026-10-10 12:00:00'
FROM digits a, digits b, digits c, digits d;

INSERT INTO payments (id, invoice_id, amount, method, paid_at)
SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       12 + a.d * 7 + b.d * 3 + c.d,
       CASE b.d WHEN 0 THEN 'card' WHEN 1 THEN 'transfer' ELSE 'card' END,
       TIMESTAMP '2026-10-11 15:00:00'
FROM digits a, digits b, digits c, digits d
WHERE a.d >= 2;

INSERT INTO shipments (id, order_id, carrier, status, picked_up_at, promised_at, delivered_at)
SELECT a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       CASE a.d WHEN 0 THEN 'JNE' WHEN 1 THEN 'SiCepat' WHEN 2 THEN 'J&T' WHEN 3 THEN 'AnterAja'
                WHEN 4 THEN 'Pos Indonesia' ELSE 'Lion Parcel' END,
       CASE b.d WHEN 0 THEN 'in_transit' ELSE 'delivered' END,
       TIMESTAMP '2026-10-12 08:00:00',
       TIMESTAMP '2026-10-14 18:00:00',
       CASE WHEN b.d = 0 THEN NULL
            WHEN c.d < 3 THEN TIMESTAMP '2026-10-15 11:00:00'
            ELSE TIMESTAMP '2026-10-14 10:00:00' END
FROM digits a, digits b, digits c, digits d;

INSERT INTO shipment_events (id, shipment_id, kind, created_at)
SELECT 2 * (a.d + 10 * b.d + 100 * c.d + 1000 * d.d) + e.d + 1,
       a.d + 10 * b.d + 100 * c.d + 1000 * d.d + 1,
       CASE e.d WHEN 0 THEN 'picked_up' ELSE 'arrived_hub' END,
       CASE e.d WHEN 0 THEN TIMESTAMP '2026-10-12 08:00:00' ELSE TIMESTAMP '2026-10-13 07:30:00' END
FROM digits a, digits b, digits c, digits d, digits e
WHERE e.d < 2;

CREATE VIEW late_shipments AS
SELECT s.id, s.carrier, s.promised_at, s.delivered_at
FROM shipments s
WHERE s.delivered_at > s.promised_at;

CREATE VIEW open_invoices AS
SELECT i.id, i.order_id, i.amount
FROM invoices i
WHERE i.status = 'open';

DROP TABLE digits;
