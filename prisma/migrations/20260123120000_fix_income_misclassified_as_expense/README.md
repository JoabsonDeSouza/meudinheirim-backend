# Migration: Fix income transactions misclassified as expense

## Objetivo
Corrige transações que estão com `type = 'EXPENSE'` mas têm categoria de **receita** (ex.: Salário, Entrada de dinheiro), voltando-as para `type = 'INCOME'`.

Isso corrige o efeito do upgrade anterior (`fix_transaction_types`): quando categorias custom de receita estavam erroneamente com `type = 'EXPENSE'` na tabela `categories`, a migration as reclassificou para EXPENSE. Ou quando o frontend/API enviava `type: EXPENSE` em criação/edição para essas categorias.

## O que esta migration faz
1. **Categorias do sistema**: Transações com `type = EXPENSE` e `category_name` em (SALARY, FREELANCE, INVESTMENTS, SALES, RENTAL_INCOME, OTHER_INCOME) → `type = INCOME`.
2. **Categorias custom**: Transações com `type = EXPENSE` e `category_name` = `CUSTOM:uuid` onde a categoria em `categories` tem `type = INCOME` → `type = INCOME`.

## Antes de executar

### 1. Backup
```bash
pg_dump -h localhost -U seu_usuario -d meudinheirim_dev > backup_antes_fix_income_$(date +%Y%m%d).sql
```

## Como executar
```bash
cd backend-app
npm run db:migrate
```

Ou aplicar o `migration.sql` manualmente no psql/pgAdmin.

## Após executar

### 1. Recalcular saldos das contas (obrigatório)
A migration **apenas altera o `type`** das transações (EXPENSE → INCOME). Os saldos das contas (`balance`, `total_balance`, `available_balance`) **não são atualizados** — foram decrementados quando a transação foi criada como despesa e continuam errados após a correção do tipo.

Rode o script de recomputação para recalcular os saldos **apenas das contas afetadas**:

```bash
cd backend-app
npm run script:recompute-balances
```

**Importante:** O script recalcula saldos **somente** para contas que têm transações INCOME com categorias de receita (que podem ter sido corrigidas pela migration). Todas as outras contas são **deixadas intocadas**.

### 2. Reiniciar e conferir
- Reinicie o backend.
- Confira transações de salário / entrada de dinheiro: devem aparecer como receita (INCOME).
- Confira os saldos das contas afetadas: devem refletir as receitas corrigidas.
