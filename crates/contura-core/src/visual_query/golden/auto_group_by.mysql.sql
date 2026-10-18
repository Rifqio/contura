SELECT s.city,
       sum(o.total) AS sum_total,
       s.name,
       avg(o.total) AS avg_total,
       min(o.placed_at) AS min_placed_at,
       max(o.placed_at) AS max_placed_at
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
GROUP BY s.city, s.name
