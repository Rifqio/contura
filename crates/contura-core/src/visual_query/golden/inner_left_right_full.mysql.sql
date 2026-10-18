SELECT o.id,
       s.name AS s_name,
       c.name AS c_name,
       r.name AS r_name
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
LEFT JOIN customers AS c ON c.id = o.customer_id
RIGHT JOIN regions AS r ON r.id = s.region_id
