-- Money review fixes (Oct 12), from the automated tests in tests/.
--
-- 1. A voided ESA invoice no longer blocks a new one for the same child and month. The invoice function already
--    skips only live invoices, but the table's unique (child_id, class_month) refused the replacement row.
alter table public.esa_invoices drop constraint if exists esa_invoices_child_id_class_month_key;
create unique index if not exists esa_invoices_live_child_month on public.esa_invoices (child_id, class_month) where status <> 'void';

-- 2. A ClassWallet receipt whose parent email has capitals now finds its family (the guardian side was already
--    lowercased; the receipt side was not). The rest of the function is unchanged from migration 0012.
create or replace function app.link_classwallet_orders()
returns jsonb language plpgsql set search_path = public
as $$
declare r record; d text; fam int := 0; kid int := 0; kid2 int := 0; tied int := 0;
begin
  -- Family: the parent email on the receipt, matched to a guardian (active family first).
  update public.classwallet_orders x set family_id = m.family_id
  from (select distinct on (lower(g.email)) lower(g.email) as email, g.family_id
          from public.guardians g join public.families f on f.id = g.family_id
         where g.email is not null
         order by lower(g.email), (f.status = 'active') desc) m
  where x.family_id is null and lower(x.parent_email) = m.email;
  get diagnostics fam = row_count;

  -- Child: the student's first name within that family, only when exactly one child has it.
  update public.classwallet_orders x set child_id = c.id
  from public.children c
  where x.child_id is null and c.family_id = x.family_id
    and lower(c.first_name) = lower(split_part(x.student, ' ', 1))
    and not exists (select 1 from public.children c3
                     where c3.family_id = x.family_id and lower(c3.first_name) = lower(c.first_name) and c3.id <> c.id);
  get diagnostics kid = row_count;

  -- Otherwise the student's full name, when only one child anywhere has it (and it agrees with any family found).
  update public.classwallet_orders x set child_id = c.id, family_id = c.family_id
  from public.children c
  where x.child_id is null and (x.family_id is null or x.family_id = c.family_id)
    and lower(c.first_name || ' ' || c.last_name) = lower(x.student)
    and (select count(*) from public.children c2 where lower(c2.first_name || ' ' || c2.last_name) = lower(x.student)) = 1;
  get diagnostics kid2 = row_count;

  -- Deposit: same settled amount, landing 0 to 10 days after the order, nearest first, one deposit per receipt.
  for r in select x.* from public.classwallet_orders x
            where x.order_date >= current_date - 45
              and not exists (select 1 from public.classwallet_deposits d2 where d2.order_no = x.order_no)
            order by x.order_date, x.order_no loop
    d := null;
    select bank_txn_id into d from public.classwallet_deposits
     where order_no is null and net_cents = r.settlement_cents
       and on_date between r.order_date and r.order_date + 10
     order by on_date - r.order_date, on_date, bank_txn_id
     limit 1;
    if d is not null then
      update public.classwallet_deposits set order_no = r.order_no where bank_txn_id = d;
      tied := tied + 1;
    end if;
  end loop;

  return jsonb_build_object('families_linked', fam, 'children_linked', kid + kid2, 'deposits_named', tied);
end $$;
revoke execute on function app.link_classwallet_orders() from public, anon, authenticated;
