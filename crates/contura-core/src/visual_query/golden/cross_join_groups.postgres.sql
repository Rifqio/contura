SELECT o.id,
       c.name AS c_name,
       m.name AS m_name,
       s2.name AS s2_name
FROM public.orders AS o
JOIN public.stores AS s ON s.id = o.store_id
CROSS JOIN public.customers AS c
CROSS JOIN public.menu_items AS m
JOIN public.stores AS s2 ON s2.id = m.store_id
