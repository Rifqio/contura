SELECT o.id,
       c.name
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
LEFT JOIN customers AS c ON c.id = o.customer_id AND c.store_id = s.id
