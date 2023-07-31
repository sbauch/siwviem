import {
  isEIP55Address,
  ParsedMessage,
  parseIntegerNumber,
} from "@spruceid/siwe-parser";
import * as uri from "valid-url";
import {
  SiwViemError,
  SiwViemErrorType,
  SiwViemResponse,
  VerifyOpts,
  VerifyOptsKeys,
  VerifyParams,
  VerifyParamsKeys,
} from "./types";
import {
  Address,
  getAddress,
  recoverMessageAddress,
  verifyMessage,
} from "viem";
import {
  checkContractWalletSignature,
  checkInvalidKeys,
  generateNonce,
  isValidISO8601Date,
} from "./utils";

export class SiwViemMessage {
  /**RFC 4501 dns authority that is requesting the signing. */
  domain: string;
  /**Ethereum address performing the signing conformant to capitalization
   * encoded checksum specified in EIP-55 where applicable. */
  address: Address;
  /**Human-readable ASCII assertion that the user will sign, and it must not
   * contain `\n`. */
  statement?: string;
  /**RFC 3986 URI referring to the resource that is the subject of the signing
   *  (as in the __subject__ of a claim). */
  uri: string;
  /**Current version of the message. */
  version: string;
  /**EIP-155 Chain ID to which the session is bound, and the network where
   * Contract Accounts must be resolved. */
  chainId: number;
  /**Randomized token used to prevent replay attacks, at least 8 alphanumeric
   * characters. */
  nonce: string;
  /**ISO 8601 datetime string of the current time. */
  issuedAt?: string;
  /**ISO 8601 datetime string that, if present, indicates when the signed
   * authentication message is no longer valid. */
  expirationTime?: string;
  /**ISO 8601 datetime string that, if present, indicates when the signed
   * authentication message will become valid. */
  notBefore?: string;
  /**System-specific identifier that may be used to uniquely refer to the
   * sign-in request. */
  requestId?: string;
  /**List of information or references to information the user wishes to have
   * resolved as part of authentication by the relying party. They are
   * expressed as RFC 3986 URIs separated by `\n- `. */
  resources?: Array<string>;

  /**
   * Creates a parsed Sign-In with Ethereum Message (EIP-4361) object from a
   * string or an object. If a string is used an ABNF parser is called to
   * validate the parameter, otherwise the fields are attributed.
   * @param param {string | SiwViemMessage} Sign message as a string or an object.
   */
  constructor(param: string | Partial<SiwViemMessage>) {
    if (typeof param === "string") {
      const parsedMessage = new ParsedMessage(param);
      Object.assign(this, parsedMessage);
    } else {
      Object.assign(this, param);
      if (typeof this.chainId === "string") {
        this.chainId = parseIntegerNumber(this.chainId);
      }
    }
    this.nonce = this.nonce || generateNonce();
    this.validateMessage();
  }

  /**
   * This function can be used to retrieve an EIP-4361 formated message for
   * signature, although you can call it directly it's advised to use
   * [prepareMessage()] instead which will resolve to the correct method based
   * on the [type] attribute of this object, in case of other formats being
   * implemented.
   * @returns {string} EIP-4361 formated message, ready for EIP-191 signing.
   */
  toMessage(): string {
    /** Validates all fields of the object */
    this.validateMessage();

    const header = `${this.domain} wants you to sign in with your Ethereum account:`;
    const uriField = `URI: ${this.uri}`;
    let prefix = [header, this.address].join("\n");
    const versionField = `Version: ${this.version}`;

    if (!this.nonce) {
      this.nonce = generateNonce();
    }

    const chainField = `Chain ID: ` + this.chainId || "1";

    const nonceField = `Nonce: ${this.nonce}`;

    const suffixArray = [uriField, versionField, chainField, nonceField];

    this.issuedAt = this.issuedAt || new Date().toISOString();

    suffixArray.push(`Issued At: ${this.issuedAt}`);

    if (this.expirationTime) {
      const expiryField = `Expiration Time: ${this.expirationTime}`;

      suffixArray.push(expiryField);
    }

    if (this.notBefore) {
      suffixArray.push(`Not Before: ${this.notBefore}`);
    }

    if (this.requestId) {
      suffixArray.push(`Request ID: ${this.requestId}`);
    }

    if (this.resources) {
      suffixArray.push(
        [`Resources:`, ...this.resources.map(x => `- ${x}`)].join("\n")
      );
    }

    const suffix = suffixArray.join("\n");
    prefix = [prefix, this.statement].join("\n\n");
    if (this.statement) {
      prefix += "\n";
    }
    return [prefix, suffix].join("\n");
  }

  /**
   * This method parses all the fields in the object and creates a messaging for signing
   * message according with the type defined.
   * @returns {string} Returns a message ready to be signed according with the
   * type defined in the object.
   */
  prepareMessage(): string {
    return this.toMessage();
  }

  /**
   * Verifies the integrity of the object by matching its signature.
   * @param params Parameters to verify the integrity of the message, signature is required.
   * @param opts Options to be used for verification.
   * @returns {Promise<SiwViemMessage>} This object if valid.
   */
  async verify(
    params: VerifyParams,
    opts: VerifyOpts = { suppressExceptions: false }
  ): Promise<SiwViemResponse> {
    try {
      this.validateParams(params);
      this.validateOpts(opts);
      this.validateDomainBinding(params.domain);
      this.validateNonceBinding(params.nonce);
      this.validateMessageTime(params.time);

      const EIP4361Message = this.prepareMessage();

      const valid = await verifyMessage({
        message: EIP4361Message,
        signature: params.signature,
        address: this.address,
      });

      if (valid) {
        return { success: true, data: this };
      } else {
        const isContractWalletSignatureValid =
          opts.publicClient &&
          (await checkContractWalletSignature(
            this,
            params.signature,
            opts.publicClient
          ));
        if (isContractWalletSignatureValid) {
          return { success: true, data: this };
        } else {
          const recoveredAddress = await recoverMessageAddress({
            message: EIP4361Message,
            signature: params.signature,
          });

          throw new SiwViemError(
            SiwViemErrorType.INVALID_SIGNATURE,
            recoveredAddress,
            `Resolved address to be ${this.address}`
          );
        }
      }
    } catch (error) {
      if (opts.suppressExceptions) {
        return { success: false, data: this, error: error };
      } else {
        throw error;
      }
    }
  }

  private validateParams(params: VerifyParams): void {
    const invalidParams: Array<keyof VerifyParams> =
      checkInvalidKeys<VerifyParams>(params, VerifyParamsKeys);
    if (invalidParams.length > 0) {
      throw new Error(
        `${invalidParams.join(", ")} is/are not valid key(s) for VerifyParams.`
      );
    }
  }

  private validateOpts(opts: VerifyOpts): void {
    const invalidOpts: Array<keyof VerifyOpts> = checkInvalidKeys<VerifyOpts>(
      opts,
      VerifyOptsKeys
    );
    if (invalidOpts.length > 0) {
      throw new Error(
        `${invalidOpts.join(", ")} is/are not valid key(s) for VerifyOpts.`
      );
    }
  }

  private validateDomainBinding(domain?: string): void {
    if (domain && domain !== this.domain) {
      throw new SiwViemError(
        SiwViemErrorType.DOMAIN_MISMATCH,
        domain,
        this.domain
      );
    }
  }

  private validateNonceBinding(nonce?: string): void {
    if (nonce && nonce !== this.nonce) {
      throw new SiwViemError(
        SiwViemErrorType.NONCE_MISMATCH,
        nonce,
        this.nonce
      );
    }
  }

  private validateMessageTime(time?: string): void {
    const checkTime = new Date(time || new Date());
    if (
      this.expirationTime &&
      checkTime.getTime() >= new Date(this.expirationTime).getTime()
    ) {
      throw new SiwViemError(
        SiwViemErrorType.EXPIRED_MESSAGE,
        checkTime.toISOString(),
        this.expirationTime
      );
    }
    if (
      this.notBefore &&
      checkTime.getTime() < new Date(this.notBefore).getTime()
    ) {
      throw new SiwViemError(
        SiwViemErrorType.NOT_YET_VALID_MESSAGE,
        checkTime.toISOString(),
        this.notBefore
      );
    }
  }

  /**
   * Validates the values of this object fields.
   * @throws Throws an {ErrorType} if a field is invalid.
   */
  private validateMessage(...args) {
    /** Checks if the user might be using the function to verify instead of validate. */
    if (args.length > 0) {
      throw new SiwViemError(
        SiwViemErrorType.UNABLE_TO_PARSE,
        `Unexpected argument in the validateMessage function.`
      );
    }

    /** `domain` check. */
    if (
      !this.domain ||
      this.domain.length === 0 ||
      !/[^#?]*/.test(this.domain)
    ) {
      throw new SiwViemError(
        SiwViemErrorType.INVALID_DOMAIN,
        `${this.domain} to be a valid domain.`
      );
    }

    /** EIP-55 `address` check. */
    if (!isEIP55Address(this.address)) {
      throw new SiwViemError(
        SiwViemErrorType.INVALID_ADDRESS,
        getAddress(this.address),
        this.address
      );
    }

    /** Check if the URI is valid. */
    if (!uri.isUri(this.uri)) {
      throw new SiwViemError(
        SiwViemErrorType.INVALID_URI,
        `${this.uri} to be a valid uri.`
      );
    }

    /** Check if the version is 1. */
    if (this.version !== "1") {
      throw new SiwViemError(
        SiwViemErrorType.INVALID_MESSAGE_VERSION,
        "1",
        this.version
      );
    }

    /** Check if the nonce is alphanumeric and bigger then 8 characters */
    const nonce = this?.nonce?.match(/[a-zA-Z0-9]{8,}/);
    if (!nonce || this.nonce.length < 8 || nonce[0] !== this.nonce) {
      throw new SiwViemError(
        SiwViemErrorType.INVALID_NONCE,
        `Length > 8 (${nonce.length}). Alphanumeric.`,
        this.nonce
      );
    }

    /** `issuedAt` conforms to ISO-8601 and is a valid date. */
    if (this.issuedAt) {
      if (!isValidISO8601Date(this.issuedAt)) {
        throw new Error(SiwViemErrorType.INVALID_TIME_FORMAT);
      }
    }

    /** `expirationTime` conforms to ISO-8601 and is a valid date. */
    if (this.expirationTime) {
      if (!isValidISO8601Date(this.expirationTime)) {
        throw new Error(SiwViemErrorType.INVALID_TIME_FORMAT);
      }
    }

    /** `notBefore` conforms to ISO-8601 and is a valid date. */
    if (this.notBefore) {
      if (!isValidISO8601Date(this.notBefore)) {
        throw new Error(SiwViemErrorType.INVALID_TIME_FORMAT);
      }
    }
  }
}