SELECT o.id,
       c.name AS c_name,
       m.name AS m_name,
       s2.name AS s2_name
FROM orders AS o
JOIN stores AS s ON s.id = o.store_id
CROSS JOIN customers AS c
CROSS JOIN menu_items AS m
JOIN stores AS s2 ON s2.id = m.store_id
