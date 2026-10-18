SELECT o.id AS o_id,
       c.id AS c_id,
       count(o.id) AS count_id,
       count(DISTINCT o.id) AS count_distinct_id,
       count(c.id) AS count_id_2
FROM orders AS o
JOIN customers AS c ON c.id = o.customer_id
GROUP BY o.id, c.id
