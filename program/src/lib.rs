//! ProofPitch — trustless P2P prediction pools for World Cup 2026, settled by
//! cryptographic proof instead of an oracle admin.
//!
//! How settlement stays trustless:
//!   - TxODDS publishes Merkle roots of all score statistics on-chain every
//!     5 minutes (txoracle program, devnet 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J).
//!   - Anyone holding a TxLINE validation proof can call `settle`, which CPIs
//!     into txoracle's `validate_stat` instruction. That instruction re-hashes
//!     the proof against the published root and evaluates the market predicate
//!     (e.g. "home goals + away goals > 2") entirely on-chain.
//!   - This program only ever acts on a CPI answer of `true`. To settle the NO
//!     side, the caller proves the *negation* of the market predicate. A false
//!     answer or an invalid proof settles nothing.
//!   - No admin key, no pause switch, no oracle multisig. Funds unlock purely
//!     on proof. If no proof ever materialises (abandoned fixture), stakes are
//!     refundable after a timeout.
//!
//! Predicate model (mirrors txoracle's validate_stat):
//!   expr := stat_a | stat_a + stat_b | stat_a - stat_b
//!   P    := expr > t | expr < t | expr == t
//! All stats must carry period == 100 (the finalised full-match record).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};

// Placeholder id — Solana Playground rewrites this on the first build/deploy.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// TxLINE oracle program (devnet).
pub const TXORACLE: Pubkey =
    anchor_lang::solana_program::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// validate_stat instruction discriminator (from the published txoracle IDL).
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];
/// Finalised full-match record marker in TxLINE score stats.
pub const FINAL_PERIOD: i32 = 100;
/// An unsettled market can be voided (stakes refunded) this long after lock.
pub const VOID_AFTER_SECS: i64 = 72 * 3600;

// ── Mirrors of txoracle's borsh types (field order is the wire format) ──────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

// ── Market spec encoding (compact, u8-based) ────────────────────────────────

pub const OP_NONE: u8 = 0;
pub const OP_ADD: u8 = 1;
pub const OP_SUB: u8 = 2;

pub const CMP_GT: u8 = 0;
pub const CMP_LT: u8 = 1;
pub const CMP_EQ: u8 = 2;

pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;

pub const STATE_OPEN: u8 = 0;
pub const STATE_SETTLED_YES: u8 = 1;
pub const STATE_SETTLED_NO: u8 = 2;
pub const STATE_VOID: u8 = 3;

#[program]
pub mod proofpitch {
    use super::*;

    /// Open a new market. Permissionless: anyone can be a market creator.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        ctx: Context<CreateMarket>,
        id: u64,
        fixture_id: i64,
        stat_key_a: u32,
        stat_key_b: u32, // 0 = single-stat market
        op: u8,          // OP_NONE | OP_ADD | OP_SUB
        cmp: u8,         // CMP_GT | CMP_LT | CMP_EQ
        threshold: i32,
        lock_ts: i64,    // unix seconds — joining closes here (kickoff)
        label: String,
    ) -> Result<()> {
        require!(label.len() <= 64, PitchError::LabelTooLong);
        require!(cmp <= CMP_EQ, PitchError::BadSpec);
        require!(
            (stat_key_b == 0 && op == OP_NONE) || (stat_key_b != 0 && (op == OP_ADD || op == OP_SUB)),
            PitchError::BadSpec
        );
        let m = &mut ctx.accounts.market;
        m.creator = ctx.accounts.creator.key();
        m.id = id;
        m.fixture_id = fixture_id;
        m.stat_key_a = stat_key_a;
        m.stat_key_b = stat_key_b;
        m.op = op;
        m.cmp = cmp;
        m.threshold = threshold;
        m.lock_ts = lock_ts;
        m.yes_pool = 0;
        m.no_pool = 0;
        m.state = STATE_OPEN;
        m.settled_ts = 0;
        m.proof_ts = 0;
        m.label = label;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Stake lamports on YES or NO. One position account per (market, user, side).
    pub fn join(ctx: Context<Join>, side: u8, amount: u64) -> Result<()> {
        require!(side == SIDE_YES || side == SIDE_NO, PitchError::BadSide);
        require!(amount > 0, PitchError::ZeroStake);
        let m = &mut ctx.accounts.market;
        require!(m.state == STATE_OPEN, PitchError::MarketClosed);
        require!(
            Clock::get()?.unix_timestamp < m.lock_ts,
            PitchError::MarketLocked
        );

        // Move the stake into the market account itself (program-owned escrow).
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            amount,
        )?;

        let p = &mut ctx.accounts.position;
        p.market = m.key();
        p.owner = ctx.accounts.user.key();
        p.side = side;
        p.amount = p.amount.checked_add(amount).ok_or(PitchError::Overflow)?;
        p.claimed = false;
        p.bump = ctx.bumps.position;

        if side == SIDE_YES {
            m.yes_pool = m.yes_pool.checked_add(amount).ok_or(PitchError::Overflow)?;
        } else {
            m.no_pool = m.no_pool.checked_add(amount).ok_or(PitchError::Overflow)?;
        }
        Ok(())
    }

    /// Settle the market for `side` by proving the corresponding predicate
    /// against the on-chain TxLINE Merkle root. Fully permissionless: any
    /// keeper, user, or bystander with the proof can call this.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        ctx: Context<Settle>,
        side: u8,
        ts: i64,
        summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        predicate: TraderPredicate,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == STATE_OPEN, PitchError::MarketClosed);
        require!(side == SIDE_YES || side == SIDE_NO, PitchError::BadSide);

        // 1. The proof must be about this market's fixture and the FINAL record.
        require!(summary.fixture_id == m.fixture_id, PitchError::WrongFixture);
        require!(
            stat_a.stat_to_prove.key == m.stat_key_a
                && stat_a.stat_to_prove.period == FINAL_PERIOD,
            PitchError::WrongStat
        );
        match (m.stat_key_b, &stat_b, &op) {
            (0, None, None) => {}
            (k, Some(b), Some(o)) if k != 0 => {
                require!(
                    b.stat_to_prove.key == k && b.stat_to_prove.period == FINAL_PERIOD,
                    PitchError::WrongStat
                );
                let want = if m.op == OP_ADD { BinaryExpression::Add } else { BinaryExpression::Subtract };
                require!(*o == want, PitchError::WrongStat);
            }
            _ => return err!(PitchError::WrongStat),
        }

        // 2. The submitted predicate must be the market predicate (YES) or a
        //    valid integer negation of it (NO).
        let market_cmp = m.cmp;
        let t = m.threshold;
        let ok = match side {
            SIDE_YES => {
                (market_cmp == CMP_GT && predicate.comparison == Comparison::GreaterThan && predicate.threshold == t)
                    || (market_cmp == CMP_LT && predicate.comparison == Comparison::LessThan && predicate.threshold == t)
                    || (market_cmp == CMP_EQ && predicate.comparison == Comparison::EqualTo && predicate.threshold == t)
            }
            _ => {
                // NO wins by proving the negation:
                //   not (x > t)  ==  x < t + 1
                //   not (x < t)  ==  x > t - 1
                //   not (x == t) ==  x > t  OR  x < t
                (market_cmp == CMP_GT && predicate.comparison == Comparison::LessThan && predicate.threshold == t + 1)
                    || (market_cmp == CMP_LT && predicate.comparison == Comparison::GreaterThan && predicate.threshold == t - 1)
                    || (market_cmp == CMP_EQ && predicate.comparison == Comparison::GreaterThan && predicate.threshold == t)
                    || (market_cmp == CMP_EQ && predicate.comparison == Comparison::LessThan && predicate.threshold == t)
            }
        };
        require!(ok, PitchError::PredicateMismatch);

        // 3. The daily-roots account must be the canonical PDA for the proof's
        //    day (epoch day from the batch min timestamp, in ms — per TxLINE docs).
        let epoch_day = (summary.update_stats.min_timestamp / 86_400_000) as u16;
        let (expected_roots, _) = Pubkey::find_program_address(
            &[b"daily_scores_roots", &epoch_day.to_le_bytes()],
            &TXORACLE,
        );
        require_keys_eq!(
            ctx.accounts.daily_scores_merkle_roots.key(),
            expected_roots,
            PitchError::WrongRootsAccount
        );

        // 4. CPI into txoracle.validate_stat and demand a TRUE answer.
        let mut data = Vec::with_capacity(1024);
        data.extend_from_slice(&VALIDATE_STAT_DISC);
        ts.serialize(&mut data)?;
        summary.serialize(&mut data)?;
        fixture_proof.serialize(&mut data)?;
        main_tree_proof.serialize(&mut data)?;
        predicate.serialize(&mut data)?;
        stat_a.serialize(&mut data)?;
        stat_b.serialize(&mut data)?;
        op.serialize(&mut data)?;

        let ix = Instruction {
            program_id: TXORACLE,
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.daily_scores_merkle_roots.key(),
                false,
            )],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txoracle_program.to_account_info(),
            ],
        )?;

        let (ret_program, ret_data) = get_return_data().ok_or(PitchError::NoOracleAnswer)?;
        require_keys_eq!(ret_program, TXORACLE, PitchError::NoOracleAnswer);
        require!(ret_data.first() == Some(&1), PitchError::ProofSaysNo);

        // 5. Record the outcome.
        m.state = if side == SIDE_YES { STATE_SETTLED_YES } else { STATE_SETTLED_NO };
        m.settled_ts = Clock::get()?.unix_timestamp;
        m.proof_ts = ts;
        Ok(())
    }

    /// Refund path: if nothing could be proven for a long time after lock
    /// (abandoned fixture, void market), anyone may flip the market to VOID
    /// and stakes become refundable. Also used when the winning pool is empty.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == STATE_OPEN, PitchError::MarketClosed);
        require!(
            Clock::get()?.unix_timestamp > m.lock_ts + VOID_AFTER_SECS,
            PitchError::TooEarlyToVoid
        );
        m.state = STATE_VOID;
        m.settled_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Withdraw winnings (pro-rata share of the whole pot) or a VOID refund.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(!p.claimed, PitchError::AlreadyClaimed);

        let total = m.yes_pool.checked_add(m.no_pool).ok_or(PitchError::Overflow)?;
        let payout: u64 = match m.state {
            STATE_VOID => p.amount,
            STATE_SETTLED_YES | STATE_SETTLED_NO => {
                let winning_side = if m.state == STATE_SETTLED_YES { SIDE_YES } else { SIDE_NO };
                let winning_pool = if winning_side == SIDE_YES { m.yes_pool } else { m.no_pool };
                if winning_pool == 0 {
                    // Nobody backed the true outcome — everyone gets their stake back.
                    p.amount
                } else {
                    require!(p.side == winning_side, PitchError::LosingSide);
                    // floor(amount * total / winning_pool) in u128 — never exceeds the pot.
                    ((p.amount as u128) * (total as u128) / (winning_pool as u128)) as u64
                }
            }
            _ => return err!(PitchError::NotSettled),
        };

        // Pay directly out of the market account (program-owned escrow).
        // Rent-exempt minimum always stays: payouts sum to at most yes+no pools.
        **m.to_account_info().try_borrow_mut_lamports()? -= payout;
        **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? += payout;

        p.claimed = true;
        Ok(())
    }
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[account]
pub struct Market {
    pub creator: Pubkey,
    pub id: u64,
    pub fixture_id: i64,
    pub stat_key_a: u32,
    pub stat_key_b: u32,
    pub op: u8,
    pub cmp: u8,
    pub threshold: i32,
    pub lock_ts: i64,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub state: u8,
    pub settled_ts: i64,
    pub proof_ts: i64,
    pub label: String, // <= 64 bytes
    pub bump: u8,
}

impl Market {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 4 + 4 + 1 + 1 + 4 + 8 + 8 + 8 + 1 + 8 + 8 + (4 + 64) + 1;
}

#[account]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 1 + 1;
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Market::SPACE,
        seeds = [b"market", creator.key().as_ref(), &id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct Join<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SPACE,
        seeds = [b"pos", market.key().as_ref(), user.key().as_ref(), &[side]],
        bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: verified in the instruction against the canonical txoracle PDA
    /// for the proof's epoch day, then only ever passed to txoracle itself.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: pinned to the TxLINE oracle program id.
    #[account(address = TXORACLE)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"pos", market.key().as_ref(), user.key().as_ref(), &[position.side]],
        bump = position.bump,
        constraint = position.market == market.key() @ PitchError::WrongMarket,
        constraint = position.owner == user.key() @ PitchError::NotYourPosition,
    )]
    pub position: Account<'info, Position>,
}

#[error_code]
pub enum PitchError {
    #[msg("label longer than 64 bytes")]
    LabelTooLong,
    #[msg("invalid market spec")]
    BadSpec,
    #[msg("side must be 1 (YES) or 2 (NO)")]
    BadSide,
    #[msg("stake must be positive")]
    ZeroStake,
    #[msg("market is not open")]
    MarketClosed,
    #[msg("market is locked (kickoff passed)")]
    MarketLocked,
    #[msg("proof is for a different fixture")]
    WrongFixture,
    #[msg("proof stat does not match the market spec or is not the finalised record")]
    WrongStat,
    #[msg("predicate does not match the market (or its negation for NO)")]
    PredicateMismatch,
    #[msg("daily roots account is not the canonical txoracle PDA for that day")]
    WrongRootsAccount,
    #[msg("oracle returned no answer")]
    NoOracleAnswer,
    #[msg("the proof does not make this side's predicate true")]
    ProofSaysNo,
    #[msg("too early to void — settlement window still open")]
    TooEarlyToVoid,
    #[msg("market not settled yet")]
    NotSettled,
    #[msg("position is on the losing side")]
    LosingSide,
    #[msg("already claimed")]
    AlreadyClaimed,
    #[msg("position does not belong to this market")]
    WrongMarket,
    #[msg("position owned by someone else")]
    NotYourPosition,
}
