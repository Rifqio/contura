SELECT s.name,
       o.id AS order_id,
       c.id AS customer_id
FROM stores AS s
RIGHT JOIN orders AS o ON o.store_id = s.id
LEFT JOIN customers AS c ON c.store_id = s.id
