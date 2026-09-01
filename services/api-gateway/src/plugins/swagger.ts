import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { OpenAPIV3 } from "openapi-types";

const openapiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "NovaPay API Gateway",
    description:
      "Interactive API documentation for the NovaPay transaction backend. " +
      "All endpoints are proxied to their respective microservices.",
    version: "1.0.3",
  },
  servers: [
    { url: "http://localhost:8080", description: "Local development (nginx)" },
    { url: "http://localhost:3000", description: "Direct gateway" },
  ],
  tags: [
    { name: "Account", description: "User and wallet management" },
    { name: "Transaction", description: "Domestic and international transfers" },
    { name: "Ledger", description: "Double-entry ledger and audit" },
    { name: "FX", description: "Foreign exchange quotes" },
    { name: "Payroll", description: "Batch payroll processing" },
    { name: "Admin", description: "Incident notes and admin checks" },
    { name: "System", description: "Health, metrics, and documentation" },
  ],
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string", description: "UPPER_SNAKE_CASE error code" },
          message: { type: "string", description: "Human-readable message" },
          requestId: {
            type: "string",
            nullable: true,
            description: "Request ID from x-request-id header",
          },
        },
        required: ["error", "message"],
      },
      CreateUserRequest: {
        type: "object",
        properties: {
          email: { type: "string", format: "email", description: "User email" },
          fullName: { type: "string", description: "Full name (encrypted at rest)" },
          phone: { type: "string", description: "Phone number (encrypted at rest, optional)" },
        },
        required: ["email", "fullName"],
      },
      UserResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      CreateWalletRequest: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid", description: "Owner user ID" },
          currency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "ISO 4217 currency code",
          },
          initialBalanceCents: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Initial balance in cents",
          },
        },
        required: ["userId", "currency"],
      },
      WalletResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          currency: { type: "string", example: "USD" },
          balanceCents: { type: "string", description: "Balance in cents (BigInt as string)" },
          status: { type: "string", example: "active" },
          version: { type: "string", description: "Optimistic lock version (BigInt as string)" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      WalletSummary: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          currency: { type: "string", example: "USD" },
          balanceCents: { type: "string", description: "Balance in cents (BigInt as string)" },
          version: { type: "string", description: "Version (BigInt as string)" },
          status: { type: "string", example: "active" },
        },
      },
      ListWalletsResponse: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          wallets: {
            type: "array",
            items: { $ref: "#/components/schemas/WalletSummary" },
          },
        },
      },
      BalanceResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          balanceCents: { type: "string", description: "Balance in cents (BigInt as string)" },
          version: { type: "string", description: "Version (BigInt as string)" },
          currency: { type: "string", example: "USD" },
          status: { type: "string", example: "active" },
        },
      },
      WalletOperationRequest: {
        type: "object",
        properties: {
          operationKey: {
            type: "string",
            description: "Unique idempotency key for this operation",
          },
          deltaCents: {
            type: "integer",
            description: "Amount in cents. Positive = credit, negative = debit. Must be non-zero.",
          },
        },
        required: ["operationKey", "deltaCents"],
      },
      DomesticTransactionRequest: {
        type: "object",
        properties: {
          senderWalletId: { type: "string", format: "uuid" },
          recipientWalletId: { type: "string", format: "uuid" },
          amountCents: {
            type: "integer",
            minimum: 1,
            description: "Transfer amount in cents",
          },
          currency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "ISO 4217 currency code",
          },
        },
        required: ["senderWalletId", "recipientWalletId", "amountCents", "currency"],
      },
      InternationalTransactionRequest: {
        type: "object",
        properties: {
          senderWalletId: { type: "string", format: "uuid" },
          recipientWalletId: { type: "string", format: "uuid" },
          sourceAmountCents: {
            type: "integer",
            minimum: 1,
            description: "Source amount in cents",
          },
          sourceCurrency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "Source ISO 4217 currency code",
          },
          destinationCurrency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "Destination ISO 4217 currency code",
          },
          quoteId: {
            type: "string",
            format: "uuid",
            description: "FX quote ID obtained from POST /fx/quote",
          },
        },
        required: [
          "senderWalletId",
          "recipientWalletId",
          "sourceAmountCents",
          "sourceCurrency",
          "destinationCurrency",
          "quoteId",
        ],
      },
      TransactionResponse: {
        type: "object",
        properties: {
          transactionId: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "REVERSED"],
          },
        },
      },
      LedgerEntryInput: {
        type: "object",
        properties: {
          accountId: { type: "string", format: "uuid", description: "Wallet/account ID" },
          direction: { type: "string", enum: ["debit", "credit"] },
          amountCents: { type: "integer", minimum: 1, description: "Amount in cents" },
          currency: { type: "string", pattern: "^[A-Z]{3}$" },
          fxRate: { type: "string", description: "Optional FX rate (Decimal as string)" },
        },
        required: ["accountId", "direction", "amountCents", "currency"],
      },
      CreateLedgerBatchRequest: {
        type: "object",
        properties: {
          transactionId: { type: "string", format: "uuid" },
          entries: {
            type: "array",
            items: { $ref: "#/components/schemas/LedgerEntryInput" },
            minItems: 2,
            description: "Must have at least 2 entries. Debits must equal credits per currency.",
          },
        },
        required: ["transactionId", "entries"],
      },
      LedgerBatchResponse: {
        type: "object",
        properties: {
          ledgerTransactionId: { type: "string", format: "uuid" },
          replayed: { type: "boolean", description: "True if this was a replay of an existing batch" },
        },
      },
      LedgerBatchDetailResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          transactionId: { type: "string", format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
          entries: {
            type: "array",
            items: { $ref: "#/components/schemas/LedgerEntry" },
          },
        },
      },
      LedgerEntry: {
        type: "object",
        properties: {
          id: { type: "string", description: "Entry ID (BigInt as string)" },
          ledgerTransactionId: { type: "string", format: "uuid" },
          accountId: { type: "string", format: "uuid" },
          direction: { type: "string", enum: ["debit", "credit"] },
          amountCents: { type: "string", description: "Amount in cents (BigInt as string)" },
          currency: { type: "string", example: "USD" },
          fxRate: { type: "string", nullable: true, description: "FX rate (Decimal as string)" },
          prevHash: { type: "string", nullable: true, description: "Hash of the previous entry" },
          entryHash: { type: "string", description: "SHA-256 hash of this entry" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      InvariantCheckResponse: {
        type: "object",
        properties: {
          delta: { type: "number", description: "Sum of all currency deltas (should be 0)" },
          ok: { type: "boolean", description: "True if invariant holds for all currencies" },
          byCurrency: {
            type: "array",
            items: {
              type: "object",
              properties: {
                currency: { type: "string" },
                delta: { type: "number" },
              },
            },
          },
        },
      },
      AuditVerifyResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "True if hash chain is valid" },
          records: {
            type: "integer",
            description: "Total entries verified (present when ok=true)",
          },
          failedAt: {
            type: "integer",
            description: "1-indexed position of first broken hash (present when ok=false)",
          },
        },
      },
      CreateFxQuoteRequest: {
        type: "object",
        properties: {
          baseCurrency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "Source currency",
          },
          quoteCurrency: {
            type: "string",
            pattern: "^[A-Z]{3}$",
            description: "Target currency (must differ from baseCurrency)",
          },
        },
        required: ["baseCurrency", "quoteCurrency"],
      },
      FxQuoteResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          baseCurrency: { type: "string", example: "USD" },
          quoteCurrency: { type: "string", example: "BDT" },
          rate: { type: "string", description: "Exchange rate (Decimal as string)" },
          provider: { type: "string", example: "static-development-provider" },
          issuedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time", description: "60 seconds from creation" },
          used: { type: "boolean", example: false },
          usedAt: { type: "string", nullable: true },
          status: { type: "string", example: "active" },
          usedByTransactionId: { type: "string", nullable: true },
        },
      },
      ConsumeFxQuoteRequest: {
        type: "object",
        properties: {
          transactionId: { type: "string", format: "uuid", description: "Transaction consuming this quote" },
        },
        required: ["transactionId"],
      },
      ConsumeFxQuoteResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          rate: { type: "string", description: "Exchange rate (Decimal as string)" },
          baseCurrency: { type: "string", example: "USD" },
          quoteCurrency: { type: "string", example: "BDT" },
        },
      },
      CreatePayrollJobRequest: {
        type: "object",
        properties: {
          employerAccountId: { type: "string", format: "uuid", description: "Employer's account ID" },
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/PayrollItemInput" },
            minItems: 1,
            description: "List of payroll disbursements (must have at least 1 item)",
          },
        },
        required: ["employerAccountId", "items"],
      },
      PayrollItemInput: {
        type: "object",
        properties: {
          recipientWalletId: { type: "string", format: "uuid" },
          amountCents: { type: "integer", minimum: 1, description: "Disbursement amount in cents" },
        },
        required: ["recipientWalletId", "amountCents"],
      },
      PayrollJobAcceptedResponse: {
        type: "object",
        properties: {
          jobId: { type: "string", format: "uuid" },
          totalItems: { type: "integer" },
          status: { type: "string", example: "queued" },
        },
      },
      PayrollJobStatusResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          employerAccountId: { type: "string", format: "uuid" },
          totalItems: { type: "integer" },
          processedItems: { type: "integer" },
          failedItems: { type: "integer" },
          checkpointIndex: { type: "integer", description: "Last successfully processed item index" },
          status: {
            type: "string",
            enum: ["queued", "running", "completed"],
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CreateIncidentRequest: {
        type: "object",
        properties: {
          adminUser: { type: "string", description: "Admin who created the note" },
          note: { type: "string", description: "Incident description" },
          transactionId: {
            type: "string",
            format: "uuid",
            nullable: true,
            description: "Related transaction ID (optional)",
          },
        },
        required: ["adminUser", "note"],
      },
      IncidentNoteResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          adminUser: { type: "string" },
          transactionId: { type: "string", nullable: true },
          note: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      HealthResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "api-gateway" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        description: "Returns service health status.",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
                example: { status: "ok", service: "api-gateway" },
              },
            },
          },
        },
      },
    },
    "/metrics": {
      get: {
        tags: ["System"],
        summary: "Prometheus metrics",
        description: "Returns Prometheus-formatted metrics.",
        operationId: "getMetrics",
        responses: {
          "200": {
            description: "Prometheus metrics",
            content: {
              "text/plain": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    },
    "/accounts/users": {
      post: {
        tags: ["Account"],
        summary: "Create a user",
        description: "Create a new user. PII fields (fullName, phone) are encrypted at rest and not returned.",
        operationId: "createUser",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateUserRequest" },
              example: {
                email: "alice@example.com",
                fullName: "Alice Smith",
                phone: "+1234567890",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserResponse" },
                example: {
                  id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                  email: "alice@example.com",
                  createdAt: "2025-01-15T10:30:00.000Z",
                },
              },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "User already exists",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  error: "USER_EXISTS",
                  message: "A user with this email already exists",
                  requestId: "req-abc123",
                },
              },
            },
          },
        },
      },
    },
    "/accounts/wallets": {
      post: {
        tags: ["Account"],
        summary: "Create a wallet",
        description: "Create a new wallet for a user in the specified currency.",
        operationId: "createWallet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateWalletRequest" },
              example: {
                userId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                currency: "USD",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Wallet created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WalletResponse" },
                example: {
                  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  userId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                  currency: "USD",
                  balanceCents: "0",
                  status: "active",
                  version: "1",
                  updatedAt: "2025-01-15T10:30:00.000Z",
                },
              },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": {
            description: "User not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "User already has this currency wallet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/wallets/{userId}": {
      get: {
        tags: ["Account"],
        summary: "List wallets for a user",
        description: "Returns all wallets belonging to the specified user.",
        operationId: "listWallets",
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "User ID",
          },
        ],
        responses: {
          "200": {
            description: "Wallets listed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ListWalletsResponse" },
                example: {
                  userId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                  wallets: [
                    {
                      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                      currency: "USD",
                      balanceCents: "100000",
                      version: "1",
                      status: "active",
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    "/accounts/wallets/{walletId}/balance": {
      get: {
        tags: ["Account"],
        summary: "Get wallet balance",
        description: "Returns the balance and status of a specific wallet.",
        operationId: "getWalletBalance",
        parameters: [
          {
            name: "walletId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Wallet ID",
          },
        ],
        responses: {
          "200": {
            description: "Wallet balance",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BalanceResponse" },
                example: {
                  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  balanceCents: "100000",
                  version: "1",
                  currency: "USD",
                  status: "active",
                },
              },
            },
          },
          "404": {
            description: "Wallet not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/wallets/{walletId}/operations": {
      post: {
        tags: ["Account"],
        summary: "Apply a wallet operation",
        description:
          "Apply a debit or credit to a wallet. Use positive deltaCents for credit, negative for debit. " +
          "The operationKey must be unique per wallet for idempotency.",
        operationId: "applyWalletOperation",
        parameters: [
          {
            name: "walletId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Wallet ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WalletOperationRequest" },
              example: {
                operationKey: "deposit-001",
                deltaCents: 50000,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Operation applied",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WalletResponse" },
                example: {
                  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                  userId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                  currency: "USD",
                  balanceCents: "150000",
                  status: "active",
                  version: "2",
                  updatedAt: "2025-01-15T10:31:00.000Z",
                },
              },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": {
            description: "Insufficient funds or wallet unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  error: "INSUFFICIENT_FUNDS_OR_WALLET_UNAVAILABLE",
                  message: "Insufficient available balance or unavailable wallet",
                  requestId: "req-abc123",
                },
              },
            },
          },
        },
      },
    },
    "/transactions": {
      post: {
        tags: ["Transaction"],
        summary: "Initiate a domestic transfer",
        description:
          "Create a domestic transfer between two wallets. " +
          "Requires an `Idempotency-Key` header for idempotency. " +
          "Amount is in the sender's currency.",
        operationId: "createDomesticTransaction",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Unique idempotency key for this transfer",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DomesticTransactionRequest" },
              example: {
                senderWalletId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                recipientWalletId: "f0e1d2c3-b4a5-6789-0abc-def123456789",
                amountCents: 10000,
                currency: "USD",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Transfer completed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransactionResponse" },
                example: {
                  transactionId: "b5a4c3d2-e1f0-9876-5432-10fedcba9876",
                  status: "COMPLETED",
                },
              },
            },
          },
          "202": {
            description: "Transfer is still processing (idempotency replay)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransactionResponse" },
              },
            },
          },
          "400": {
            description: "Validation error or missing Idempotency-Key",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Idempotency conflict (key expired, payload mismatch, or race condition)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/transfers/international": {
      post: {
        tags: ["Transaction"],
        summary: "Initiate an international transfer",
        description:
          "Create an international transfer with currency conversion. " +
          "Requires a pre-issued FX quote from POST /fx/quote and an `Idempotency-Key` header. " +
          "The quote is atomically consumed upon successful transfer.",
        operationId: "createInternationalTransaction",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Unique idempotency key for this transfer",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InternationalTransactionRequest" },
              example: {
                senderWalletId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                recipientWalletId: "f0e1d2c3-b4a5-6789-0abc-def123456789",
                sourceAmountCents: 10000,
                sourceCurrency: "USD",
                destinationCurrency: "BDT",
                quoteId: "c7d8e9f0-a1b2-3456-7890-abcdef123456",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Transfer completed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransactionResponse" },
                example: {
                  transactionId: "e5f6a7b8-c9d0-1234-5678-9abcdef01234",
                  status: "COMPLETED",
                },
              },
            },
          },
          "202": {
            description: "Transfer is still processing (idempotency replay)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransactionResponse" },
              },
            },
          },
          "400": {
            description: "Validation error or missing Idempotency-Key",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Idempotency conflict or FX quote already used/expired",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": {
            description: "FX quote currency mismatch",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "503": {
            description: "FX provider unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/ledger/batches": {
      post: {
        tags: ["Ledger"],
        summary: "Write a ledger batch",
        description:
          "Write a double-entry ledger batch. Debits must equal credits per currency. " +
          "Each batch is idempotent per transactionId.",
        operationId: "createLedgerBatch",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateLedgerBatchRequest" },
              example: {
                transactionId: "b5a4c3d2-e1f0-9876-5432-10fedcba9876",
                entries: [
                  {
                    accountId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                    direction: "debit",
                    amountCents: 10000,
                    currency: "USD",
                  },
                  {
                    accountId: "f0e1d2c3-b4a5-6789-0abc-def123456789",
                    direction: "credit",
                    amountCents: 10000,
                    currency: "USD",
                  },
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Batch created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LedgerBatchResponse" },
                example: {
                  ledgerTransactionId: "c3d4e5f6-a7b8-9012-3456-789abcdef012",
                },
              },
            },
          },
          "200": {
            description: "Batch already exists (replay)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LedgerBatchResponse" },
                example: {
                  ledgerTransactionId: "c3d4e5f6-a7b8-9012-3456-789abcdef012",
                  replayed: true,
                },
              },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": {
            description: "Unbalanced ledger (debits != credits per currency)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/ledger/batches/{transactionId}": {
      get: {
        tags: ["Ledger"],
        summary: "Get a ledger batch",
        description: "Retrieve a ledger batch and its entries by transaction ID.",
        operationId: "getLedgerBatch",
        parameters: [
          {
            name: "transactionId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Transaction ID",
          },
        ],
        responses: {
          "200": {
            description: "Ledger batch found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LedgerBatchDetailResponse" },
              },
            },
          },
          "404": {
            description: "Ledger batch not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/ledger/invariant-check": {
      get: {
        tags: ["Ledger"],
        summary: "Check ledger invariant",
        description:
          "Verify that total debits equal total credits across all currencies. " +
          "Returns per-currency deltas and a Prometheus counter on violation.",
        operationId: "checkLedgerInvariant",
        responses: {
          "200": {
            description: "Invariant check result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/InvariantCheckResponse" },
                example: {
                  delta: 0,
                  ok: true,
                  byCurrency: [{ currency: "USD", delta: 0 }],
                },
              },
            },
          },
        },
      },
    },
    "/ledger/audit/verify": {
      get: {
        tags: ["Ledger"],
        summary: "Verify audit hash chain",
        description:
          "Recompute the SHA-256 hash chain from the first ledger entry. " +
          "Detects any historical tampering with amounts or directions.",
        operationId: "verifyAuditChain",
        responses: {
          "200": {
            description: "Audit verification result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuditVerifyResponse" },
                example: {
                  ok: true,
                  records: 12,
                },
              },
            },
          },
        },
      },
    },
    "/fx/quote": {
      post: {
        tags: ["FX"],
        summary: "Create an FX quote",
        description:
          "Request an exchange rate quote. The quote is valid for 60 seconds and can be consumed once. " +
          "Returns 503 if the FX provider is unavailable.",
        operationId: "createFxQuote",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateFxQuoteRequest" },
              example: {
                baseCurrency: "USD",
                quoteCurrency: "BDT",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Quote created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FxQuoteResponse" },
                example: {
                  id: "c7d8e9f0-a1b2-3456-7890-abcdef123456",
                  baseCurrency: "USD",
                  quoteCurrency: "BDT",
                  rate: "110.50",
                  provider: "static-development-provider",
                  issuedAt: "2025-01-15T10:30:00.000Z",
                  expiresAt: "2025-01-15T10:31:00.000Z",
                  used: false,
                  usedAt: null,
                  status: "active",
                  usedByTransactionId: null,
                },
              },
            },
          },
          "400": {
            description: "Validation error (e.g., same currency for base and quote)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "503": {
            description: "FX provider unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: {
                  error: "FX_PROVIDER_UNAVAILABLE",
                  message: "FX provider is unavailable; no cached rate is used",
                  requestId: "req-abc123",
                },
              },
            },
          },
        },
      },
    },
    "/fx/quote/{id}": {
      get: {
        tags: ["FX"],
        summary: "Get an FX quote",
        description: "Retrieve an FX quote by ID to check its validity and rate.",
        operationId: "getFxQuote",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Quote ID",
          },
        ],
        responses: {
          "200": {
            description: "Quote found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FxQuoteResponse" },
              },
            },
          },
          "404": {
            description: "Quote not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/fx/quote/{id}/consume": {
      post: {
        tags: ["FX"],
        summary: "Consume an FX quote",
        description:
          "Atomically consume a quote for a specific transaction. " +
          "The quote must not be expired or already used. " +
          "Returns 409 if the quote was already consumed or expired.",
        operationId: "consumeFxQuote",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Quote ID",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ConsumeFxQuoteRequest" },
              example: {
                transactionId: "b5a4c3d2-e1f0-9876-5432-10fedcba9876",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Quote consumed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConsumeFxQuoteResponse" },
                example: {
                  id: "c7d8e9f0-a1b2-3456-7890-abcdef123456",
                  rate: "110.50",
                  baseCurrency: "USD",
                  quoteCurrency: "BDT",
                },
              },
            },
          },
          "400": {
            description: "Validation error (missing transactionId)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": {
            description: "Quote not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "409": {
            description: "Quote already used or expired",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/payroll/jobs": {
      post: {
        tags: ["Payroll"],
        summary: "Create a payroll batch job",
        description:
          "Submit a batch of payroll disbursements. Processing is asynchronous via BullMQ. " +
          "Returns 202 Accepted with a job ID for status polling.",
        operationId: "createPayrollJob",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreatePayrollJobRequest" },
              example: {
                employerAccountId: "e1f2a3b4-c5d6-7890-abcd-ef1234567890",
                items: [
                  { recipientWalletId: "f0e1d2c3-b4a5-6789-0abc-def123456789", amountCents: 50000 },
                  { recipientWalletId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", amountCents: 75000 },
                ],
              },
            },
          },
        },
        responses: {
          "202": {
            description: "Job accepted for processing",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollJobAcceptedResponse" },
                example: {
                  jobId: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                  totalItems: 2,
                  status: "queued",
                },
              },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/payroll/jobs/{id}": {
      get: {
        tags: ["Payroll"],
        summary: "Get payroll job status",
        description:
          "Check the status and progress of a payroll job. " +
          "The checkpointIndex indicates how many items have been processed.",
        operationId: "getPayrollJob",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Job ID",
          },
        ],
        responses: {
          "200": {
            description: "Job status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PayrollJobStatusResponse" },
                example: {
                  id: "f1a2b3c4-d5e6-7890-abcd-ef1234567890",
                  employerAccountId: "e1f2a3b4-c5d6-7890-abcd-ef1234567890",
                  totalItems: 2,
                  processedItems: 2,
                  failedItems: 0,
                  checkpointIndex: 2,
                  status: "completed",
                  createdAt: "2025-01-15T10:30:00.000Z",
                  updatedAt: "2025-01-15T10:30:05.000Z",
                },
              },
            },
          },
          "404": {
            description: "Job not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/admin/incidents": {
      post: {
        tags: ["Admin"],
        summary: "Record an incident note",
        description: "Create an incident note for manual review or audit tracking.",
        operationId: "createIncident",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateIncidentRequest" },
              example: {
                adminUser: "ops@novapay.com",
                transactionId: "b5a4c3d2-e1f0-9876-5432-10fedcba9876",
                note: "Manual review required for flagged transaction",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Incident note created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/IncidentNoteResponse" },
                example: {
                  id: "d4e5f6a7-b8c9-0123-4567-89abcdef0123",
                  adminUser: "ops@novapay.com",
                  transactionId: "b5a4c3d2-e1f0-9876-5432-10fedcba9876",
                  note: "Manual review required for flagged transaction",
                  createdAt: "2025-01-15T10:30:00.000Z",
                },
              },
            },
          },
          "400": {
            description: "Validation error (missing adminUser or note)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
  },
};

export async function registerSwagger(app: FastifyInstance) {
  await app.register(swagger, {
    mode: "static",
    specification: {
      document: openapiDocument,
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });
}
