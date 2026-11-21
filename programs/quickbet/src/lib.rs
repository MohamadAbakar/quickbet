//! QuickBet: a table escrow for friends. Every seat locks the same buy-in into a
//! vault owned by the table PDA. When strictly more than half of the seated
//! players submit an identical payout vector, the vault pays it out. If no
//! majority is reached before the deadline, anyone can trigger a full refund.
//!
//! DEVNET DEMO ONLY. No house fee, no rake.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("5PvfZ55DA7pK1zK1AAd1HLPXZmbdykFBFFuU4i6KepJ3");

pub const TABLE_SEED: &[u8] = b"table";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MAX_PLAYERS: usize = 6;
pub const MIN_PLAYERS: u8 = 2;
pub const MAX_NAME_LEN: usize = 40;
pub const MAX_MODE: u8 = 2;

#[program]
pub mod quickbet {
    use super::*;

    pub fn create_table(
        ctx: Context<CreateTable>,
        table_id: u64,
        mode: u8,
        buy_in: u64,
        max_players: u8,
        settle_window_secs: i64,
        target: u8,
        name: String,
    ) -> Result<()> {
        require!(buy_in > 0, QuickBetError::InvalidBuyIn);
        require!(
            (MIN_PLAYERS..=MAX_PLAYERS as u8).contains(&max_players),
            QuickBetError::InvalidMaxPlayers
        );
        require!(mode <= MAX_MODE, QuickBetError::InvalidMode);
        require!(settle_window_secs > 0, QuickBetError::InvalidWindow);
        require!(name.len() <= MAX_NAME_LEN, QuickBetError::NameTooLong);

        let host = ctx.accounts.host.key();
        let table = &mut ctx.accounts.table;
        table.host = host;
        table.table_id = table_id;
        table.mint = ctx.accounts.mint.key();
        table.buy_in = buy_in;
        table.max_players = max_players;
        table.mode = mode;
        table.target = target;
        table.state = TableState::Open;
        table.name = name;
        table.players = vec![host];
        table.voted = [false; MAX_PLAYERS];
        table.votes = [[0u64; MAX_PLAYERS]; MAX_PLAYERS];
        table.settle_window_secs = settle_window_secs;
        table.deadline_ts = 0;
        table.created_ts = Clock::get()?.unix_timestamp;
        table.bump = ctx.bumps.table;
        table.vault_bump = ctx.bumps.vault;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.host_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.host.to_account_info(),
                },
            ),
            buy_in,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TableCreated {
            table: ctx.accounts.table.key(),
            host,
            table_id,
            mode,
            buy_in,
            max_players,
        });
        Ok(())
    }

    pub fn join_table(ctx: Context<JoinTable>) -> Result<()> {
        let player = ctx.accounts.player.key();
        let table = &mut ctx.accounts.table;
        require!(table.state == TableState::Open, QuickBetError::NotOpen);
        require!(
            table.players.len() < table.max_players as usize,
            QuickBetError::TableFull
        );
        require!(
            !table.players.contains(&player),
            QuickBetError::AlreadySeated
        );
        table.players.push(player);
        let buy_in = table.buy_in;
        let seat = (table.players.len() - 1) as u8;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.player_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            buy_in,
            ctx.accounts.mint.decimals,
        )?;

        emit!(PlayerJoined {
            table: ctx.accounts.table.key(),
            player,
            seat,
        });
        Ok(())
    }

    pub fn leave_table(ctx: Context<LeaveTable>) -> Result<()> {
        let player = ctx.accounts.player.key();
        let table_key = ctx.accounts.table.key();
        let (buy_in, seeds_host, seeds_id, bump) = {
            let table = &mut ctx.accounts.table;
            require!(table.state == TableState::Open, QuickBetError::NotOpen);
            require!(player != table.host, QuickBetError::HostCannotLeave);
            let idx = table
                .players
                .iter()
                .position(|p| *p == player)
                .ok_or(QuickBetError::NotSeated)?;
            table.players.remove(idx);
            (table.buy_in, table.host, table.table_id.to_le_bytes(), table.bump)
        };

        let signer: &[&[&[u8]]] = &[&[TABLE_SEED, seeds_host.as_ref(), &seeds_id, &[bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.player_token.to_account_info(),
                    authority: ctx.accounts.table.to_account_info(),
                },
                signer,
            ),
            buy_in,
            ctx.accounts.mint.decimals,
        )?;

        emit!(PlayerLeft {
            table: table_key,
            player,
        });
        Ok(())
    }

    pub fn start_table(ctx: Context<StartTable>) -> Result<()> {
        let table = &mut ctx.accounts.table;
        require!(table.state == TableState::Open, QuickBetError::NotOpen);
        require!(
            table.players.len() >= MIN_PLAYERS as usize,
            QuickBetError::NotEnoughPlayers
        );
        let now = Clock::get()?.unix_timestamp;
        table.deadline_ts = now
            .checked_add(table.settle_window_secs)
            .ok_or(QuickBetError::MathOverflow)?;
        table.state = TableState::Live;
        emit!(TableStarted {
            table: table.key(),
            players: table.players.len() as u8,
            deadline_ts: table.deadline_ts,
        });
        Ok(())
    }

    /// Remaining accounts (only needed when this vote completes a majority):
    /// one writable token account per seat, in seat order.
    pub fn submit_result<'info>(
        ctx: Context<'info, SubmitResult<'info>>,
        payouts: Vec<u64>,
    ) -> Result<()> {
        let voter = ctx.accounts.player.key();
        let table_key = ctx.accounts.table.key();

        let (settle, n) = {
            let table = &mut ctx.accounts.table;
            require!(table.state == TableState::Live, QuickBetError::NotLive);
            let n = table.players.len();
            let seat = table
                .players
                .iter()
                .position(|p| *p == voter)
                .ok_or(QuickBetError::NotSeated)?;
            require!(payouts.len() == n, QuickBetError::WrongPayoutLength);

            let mut sum: u64 = 0;
            for amount in payouts.iter() {
                sum = sum.checked_add(*amount).ok_or(QuickBetError::MathOverflow)?;
            }
            let pot = table
                .buy_in
                .checked_mul(n as u64)
                .ok_or(QuickBetError::MathOverflow)?;
            require!(sum == pot, QuickBetError::WrongPayoutSum);

            let mut vote = [0u64; MAX_PLAYERS];
            vote[..n].copy_from_slice(&payouts);
            table.votes[seat] = vote;
            table.voted[seat] = true;

            let matching = (0..n)
                .filter(|i| table.voted[*i] && table.votes[*i] == vote)
                .count();
            emit!(ResultSubmitted {
                table: table_key,
                player: voter,
                matching: matching as u8,
            });
            (matching * 2 > n, n)
        };

        if !settle {
            return Ok(());
        }

        pay_every_seat(
            &mut ctx.accounts.table,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
            ctx.remaining_accounts,
            &payouts[..n],
        )?;
        ctx.accounts.table.state = TableState::Settled;
        emit!(TableSettled {
            table: table_key,
            payouts,
        });
        Ok(())
    }

    /// Anyone can call after the deadline. Remaining accounts: one writable
    /// token account per seat, in seat order.
    pub fn refund<'info>(ctx: Context<'info, Refund<'info>>) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let amounts = {
            let table = &ctx.accounts.table;
            require!(table.state == TableState::Live, QuickBetError::NotLive);
            let now = Clock::get()?.unix_timestamp;
            require!(now > table.deadline_ts, QuickBetError::DeadlineNotReached);
            vec![table.buy_in; table.players.len()]
        };
        pay_every_seat(
            &mut ctx.accounts.table,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
            ctx.remaining_accounts,
            &amounts,
        )?;
        ctx.accounts.table.state = TableState::Refunded;
        emit!(TableRefunded {
            table: table_key,
            reason: 0,
        });
        Ok(())
    }

    /// Host only, while Open. Remaining accounts: one writable token account
    /// per seat, in seat order.
    pub fn cancel_table<'info>(ctx: Context<'info, CancelTable<'info>>) -> Result<()> {
        let table_key = ctx.accounts.table.key();
        let amounts = {
            let table = &ctx.accounts.table;
            require!(table.state == TableState::Open, QuickBetError::NotOpen);
            vec![table.buy_in; table.players.len()]
        };
        pay_every_seat(
            &mut ctx.accounts.table,
            &ctx.accounts.vault,
            &ctx.accounts.mint,
            &ctx.accounts.token_program,
            ctx.remaining_accounts,
            &amounts,
        )?;
        ctx.accounts.table.state = TableState::Refunded;
        emit!(TableRefunded {
            table: table_key,
            reason: 1,
        });
        Ok(())
    }
}

/// Pays `amounts[i]` from the vault to the token account passed for seat `i`.
/// Every destination is checked: owned by the token program, same mint, and
/// owned by the seated player's wallet.
fn pay_every_seat<'info>(
    table: &mut Account<'info, Table>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    remaining: &'info [AccountInfo<'info>],
    amounts: &[u64],
) -> Result<()> {
    let n = table.players.len();
    require!(remaining.len() == n, QuickBetError::WrongSeatAccounts);
    require!(amounts.len() == n, QuickBetError::WrongPayoutLength);

    let host = table.host;
    let id = table.table_id.to_le_bytes();
    let bump = [table.bump];
    let signer: &[&[&[u8]]] = &[&[TABLE_SEED, host.as_ref(), &id, &bump]];
    let table_ai = table.to_account_info();

    for (i, dest) in remaining.iter().enumerate() {
        require!(
            dest.owner == &token_program.key(),
            QuickBetError::WrongSeatAccount
        );
        require!(dest.is_writable, QuickBetError::WrongSeatAccount);
        {
            let data = dest.try_borrow_data()?;
            let parsed = TokenAccount::try_deserialize(&mut &data[..])
                .map_err(|_| error!(QuickBetError::WrongSeatAccount))?;
            require_keys_eq!(parsed.mint, table.mint, QuickBetError::WrongSeatAccount);
            require_keys_eq!(
                parsed.owner,
                table.players[i],
                QuickBetError::WrongSeatAccount
            );
        }
        let amount = amounts[i];
        if amount == 0 {
            continue;
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to: dest.clone(),
                    authority: table_ai.clone(),
                },
                signer,
            ),
            amount,
            mint.decimals,
        )?;
    }
    Ok(())
}

// ---------------- Accounts ----------------

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreateTable<'info> {
    #[account(mut)]
    pub host: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = host,
        token::token_program = token_program,
    )]
    pub host_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = host,
        space = 8 + Table::INIT_SPACE,
        seeds = [TABLE_SEED, host.key().as_ref(), &table_id.to_le_bytes()],
        bump,
    )]
    pub table: Box<Account<'info, Table>>,

    #[account(
        init,
        payer = host,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = table,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinTable<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = mint @ QuickBetError::WrongMint,
    )]
    pub table: Box<Account<'info, Table>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program,
    )]
    pub player_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = table.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct LeaveTable<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = mint @ QuickBetError::WrongMint,
    )]
    pub table: Box<Account<'info, Table>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program,
    )]
    pub player_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = table.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct StartTable<'info> {
    pub host: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = host @ QuickBetError::NotHost,
    )]
    pub table: Box<Account<'info, Table>>,
}

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = mint @ QuickBetError::WrongMint,
    )]
    pub table: Account<'info, Table>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = table.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = mint @ QuickBetError::WrongMint,
    )]
    pub table: Account<'info, Table>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = table.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelTable<'info> {
    pub host: Signer<'info>,

    #[account(
        mut,
        seeds = [TABLE_SEED, table.host.as_ref(), &table.table_id.to_le_bytes()],
        bump = table.bump,
        has_one = host @ QuickBetError::NotHost,
        has_one = mint @ QuickBetError::WrongMint,
    )]
    pub table: Account<'info, Table>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, table.key().as_ref()],
        bump = table.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------- State ----------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TableState {
    Open,
    Live,
    Settled,
    Refunded,
}

/// Layout note for clients: fields are decoded in this exact order.
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub host: Pubkey,
    pub table_id: u64,
    pub mint: Pubkey,
    pub buy_in: u64,
    pub max_players: u8,
    /// 0 poker, 1 pick a side, 2 score match (informational only)
    pub mode: u8,
    /// Target score for score match (informational only)
    pub target: u8,
    pub state: TableState,
    pub settle_window_secs: i64,
    pub deadline_ts: i64,
    pub created_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Seat order = join order
    #[max_len(6)]
    pub players: Vec<Pubkey>,
    /// Whether seat i has submitted a payout vector
    pub voted: [bool; 6],
    /// Seat i's submitted payout vector (padded with zeros past players.len()).
    /// Stored in full instead of a hash: at most 6 x 6 u64, and no hashing needed.
    pub votes: [[u64; 6]; 6],
    #[max_len(40)]
    pub name: String,
}

// ---------------- Events ----------------

#[event]
pub struct TableCreated {
    pub table: Pubkey,
    pub host: Pubkey,
    pub table_id: u64,
    pub mode: u8,
    pub buy_in: u64,
    pub max_players: u8,
}

#[event]
pub struct PlayerJoined {
    pub table: Pubkey,
    pub player: Pubkey,
    pub seat: u8,
}

#[event]
pub struct PlayerLeft {
    pub table: Pubkey,
    pub player: Pubkey,
}

#[event]
pub struct TableStarted {
    pub table: Pubkey,
    pub players: u8,
    pub deadline_ts: i64,
}

#[event]
pub struct ResultSubmitted {
    pub table: Pubkey,
    pub player: Pubkey,
    pub matching: u8,
}

#[event]
pub struct TableSettled {
    pub table: Pubkey,
    pub payouts: Vec<u64>,
}

#[event]
pub struct TableRefunded {
    pub table: Pubkey,
    /// 0 = deadline passed, 1 = host cancelled
    pub reason: u8,
}

// ---------------- Errors ----------------

#[error_code]
pub enum QuickBetError {
    #[msg("Buy-in must be greater than zero")]
    InvalidBuyIn,
    #[msg("Max players must be between 2 and 6")]
    InvalidMaxPlayers,
    #[msg("Unknown game mode")]
    InvalidMode,
    #[msg("Settle window must be positive")]
    InvalidWindow,
    #[msg("Bet name is too long (40 bytes max)")]
    NameTooLong,
    #[msg("Table is not open for joining")]
    NotOpen,
    #[msg("Table is not live")]
    NotLive,
    #[msg("Table is full")]
    TableFull,
    #[msg("You are already seated at this table")]
    AlreadySeated,
    #[msg("You are not seated at this table")]
    NotSeated,
    #[msg("The host cannot leave; cancel the table instead")]
    HostCannotLeave,
    #[msg("Only the host can do this")]
    NotHost,
    #[msg("Need at least 2 players to start")]
    NotEnoughPlayers,
    #[msg("Payout vector must have one entry per seat")]
    WrongPayoutLength,
    #[msg("Payouts must add up to the whole pot")]
    WrongPayoutSum,
    #[msg("Pass exactly one token account per seat, in seat order")]
    WrongSeatAccounts,
    #[msg("A seat's token account does not match that player and mint")]
    WrongSeatAccount,
    #[msg("Mint does not match this table")]
    WrongMint,
    #[msg("Refund is only possible after the deadline")]
    DeadlineNotReached,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
