-- Ties ClassWallet receipts to families, children and bank deposits. Run by the morning sweep after it loads new
-- receipts (select app.link_classwallet_orders();). Idempotent. Not callable from the app.
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
  where x.family_id is null and x.parent_email = m.email;
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

-- Audit what staff change on a deposit (status, the invoice it paid, the note), not the sweep's naming.
create or replace trigger audit_cw_deposits after update of status, esa_invoice_id, note on public.classwallet_deposits
  for each row execute function app.audit();
