SELECT e.name AS e_name,
       e2.name AS e2_name
FROM employees AS e
LEFT JOIN employees AS e2 ON e2.id = e.manager_id
WHERE e2.id IS NOT NULL
