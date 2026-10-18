SELECT o.id,
       s.name AS s_name,
       c.name AS c_name,
       r.name AS r_name,
       m.name AS m_name
FROM public.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
LEFT JOIN public.customers AS c ON c.id = o.customer_id
RIGHT JOIN public.regions AS r ON r.id = s.region_id
FULL JOIN public.menu_items AS m ON m.store_id = s.id
