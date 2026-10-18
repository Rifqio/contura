SELECT o.id,
       o.total AS amount
FROM orders AS o
ORDER BY amount DESC, o.placed_at, o.id
