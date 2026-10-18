SELECT s.city,
       count(o.id) AS orders
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
GROUP BY s.city, s.region_id
ORDER BY s.region_id
