SELECT o.id,
       s.city,
       r.code
FROM orders AS o
CROSS JOIN stores AS s
JOIN regions AS r ON r.id = s.region_id
WHERE s.city = 'Oslo'
ORDER BY r.code
