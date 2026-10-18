SELECT o.id,
       s.city
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
