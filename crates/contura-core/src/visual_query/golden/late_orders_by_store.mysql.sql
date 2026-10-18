SELECT s.name,
       s.city,
       count(o.id) AS late_orders,
       sum(o.total) AS late_total
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
LEFT JOIN customers AS c ON c.id = o.customer_id
WHERE o.status = 'late'
  AND o.placed_at >= '2026-10-01'
  AND o.channel IN ('app', 'kiosk')
GROUP BY s.name, s.city
ORDER BY late_orders DESC, s.name
LIMIT 50
