SELECT l.order_id,
       l.line_no,
       sh.shipped_at
FROM order_lines AS l
JOIN shipments AS sh ON sh.order_id = l.order_id AND sh.line_no = l.line_no
