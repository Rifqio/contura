SELECT s.name AS s_name,
       r.name AS r_name,
       c.email
FROM stores AS s
JOIN regions AS r ON r.id = s.region_id
CROSS JOIN customers AS c
LIMIT 100
