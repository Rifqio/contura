SELECT o.id,
       c.id AS customer_id,
       c.name
FROM orders AS o
LEFT JOIN customers AS c ON c.id = o.customer_id
ORDER BY o.id DESC, customer_id
