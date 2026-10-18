SELECT o.id,
       s.name,
       o2.archived_at
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
LEFT JOIN archive.orders AS o2 ON o2.id = o.id
