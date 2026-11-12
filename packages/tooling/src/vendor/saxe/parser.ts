/*
 * Based on @federicocarboni/saxe 0.8.0 by Federico Carboni.
 * Modified by Hesperia to restrict its private XML parser to DTD-prohibited
 * operation, remove successful DTD processing, and enforce decoded logical
 * text-run length limits.
 * Licensed under the Apache License, Version 2.0. See LICENSE.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  Chars,
  hasInvalidChar,
  isChar,
  isNameChar,
  isNameStartChar,
  isWhiteSpace,
} from "./chars.ts";
import {SaxError} from "./error.ts";
import {parseXmlDecl} from "./xml_decl.ts";

/**
 * XML declaration.
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8" standalone="no" ?>
 * ```
 */
export interface XmlDeclaration {
  /**
   * Version declared in the XML Declaration. Generally `1.0` or `1.1`.
   */
  version: string;
  /**
   * Encoding in the XML Declaration, or `undefined` when unspecified. The
   * encoding label is converted to lower case to be consistent with the
   * `encoding` property of `TextDecoder`, and ensures encoding labels are
   * processed in a case-insensitive way.
   *
   * The parser does not validate that the encoding label is one of the
   * officially assigned [IANA Character Sets] nor does it resolve aliases.
   *
   * [IANA Character Sets]:
   * https://www.iana.org/assignments/character-sets/character-sets.xhtml
   */
  encoding?: string | undefined;
  /**
   * Standalone value declared in the XML declaration.
   *
   * `true` when set to `yes`, `false` when set to `no`, or `undefined` when
   * unspecified.
   */
  standalone?: boolean | undefined;
}

/**
 * Document type declaration.
 *
 * ```xml
 * <!DOCTYPE example PUBLIC "-//Example//example" "./example.dtd">
 * ```
 */
export interface Doctype {
  /**
   * Name in the document type declaration.
   */
  name: string;
  /**
   * Public identifier in the document type declaration, if present.
   *
   * All whitespace in the public identifier is normalized to single space
   * characters, and leading and trailing whitespace is removed.
   */
  publicId?: string | undefined;
  /**
   * System identifier in the document type declaration, if present.
   *
   * It is meant to be converted to a URI reference relative to the document
   * entity, the parser does not process it as external markup declarations are
   * not supported.
   *
   * System identifiers may contain characters that, according to
   * [IETF RFC 3986], must be escaped before a URI can be used to retrieve the
   * referenced resource.
   *
   * [IETF RFC 3986]: https://www.ietf.org/rfc/rfc3986.txt
   */
  systemId?: string | undefined;
}

/**
 * An immutable collection of the attributes of an XML tag.
 *
 * Attributes are iterable and ordered as specified in the XML tag.
 */
export interface Attributes {
  /** The number of attributes. */
  readonly size: number;
  /**
   * @param name - Name of the attribute.
   * @returns - Returns the value of the attribute with the specified name.
   * If there is no attribute with the specified name `undefined` is returned.
   */
  get(name: string): string | undefined;
  /**
   * @param name - Name of the attribute.
   * @returns - Returns a boolean value indicating whether an attribute with the
   * specified name is present.
   */
  has(name: string): boolean;
  /**
   * Executes `callbackfn` for each attribute.
   * @param callbackfn -
   * @param thisArg -
   */
  forEach(
    callbackfn: (value: string, name: string, attributes: Attributes) => void,
    thisArg?: unknown,
  ): void;
  /** @returns - Returns an iterator over the names of the attributes. */
  keys(): IterableIterator<string>;
  /** @returns - Returns an iterator over the values of the attributes. */
  values(): IterableIterator<string>;
  /**
   * @returns - Returns an iterator over the names and values of the attributes.
   */
  entries(): IterableIterator<[string, string]>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

export interface SaxLexicalHandler {
  /**
   * XML declaration of the document.
   *
   * ```xml
   * <?xml version="1.0" encoding="UTF-8" standalone="no" ?>
   * ```
   *
   * @param xmlDecl -
   */
  xmlDecl?(xmlDecl: XmlDeclaration): void;
  /**
   * Document type declaration.
   *
   * ```xml
   * <!DOCTYPE example PUBLIC "-//Example//example" "./example.dtd">
   * ```
   *
   * This private parser rejects recognized declarations before invoking this
   * handler.
   * @param doctype -
   */
  doctype?(doctype: Doctype): void;
  /**
   * A processing instruction.
   *
   * ```xml
   * <?target content?>
   * ```
   *
   * @param target - Processing instruction target, used to identify the
   * application to which the instruction is directed.
   * @param content - Processing instruction content, whitespace is not trimmed
   * or normalized.
   */
  processingInstruction?(target: string, content: string): void;
  /**
   * A comment.
   *
   * ```xml
   * <!-- content -->
   * ```
   *
   * @param content - Comment content, whitespace is not trimmed or normalized.
   */
  comment?(content: string): void;
  /**
   * Start of a CDATA section.
   *
   * ```xml
   * <![CDATA[
   * ```
   */
  startCDataSection?(): void;
  /**
   * End of a CDATA section.
   *
   * ```xml
   * ]]>
   * ```
   */
  endCDataSection?(): void;
}

/**
 * https://www.w3.org/TR/REC-xml/
 */
export interface SaxHandler extends SaxLexicalHandler {
  /**
   * Start tag.
   *
   * ```xml
   * <element attr="value">
   * ```
   * @param name - Name of the element.
   * @param attributes - Attributes of the tag.
   */
  startTag(name: string, attributes: Attributes): void;
  /**
   * An end tag.
   *
   * ```xml
   * </element>
   * ```
   * @param name - Name of the element.
   */
  endTag(name: string): void;
  /**
   * Text content.
   *
   * ```xml
   * <element>
   *   content
   * </element>
   * ```
   *
   * By default, the parser collects text content as if it were forming a DOM
   * Text Node. {@linkcode SaxOptions.incrementalText} may be used to emit
   * text events as soon as more data is available.
   *
   * @param content - Text content.
   */
  text(content: string): void;
}

export interface EntityProvider {
  /**
   * Returns replacement markup for a named entity, or `undefined` when no value
   * is available. The parser does not call the provider when the XML declaration
   * specifies `standalone="yes"`.
   *
   * Note that replacement text is not treated as literal *plain* text, it is
   * parsed as *markup*, so it may contain elements, character references, or
   * even other entity references.
   *
   * If the entity value should be treated as literal plain text it should be
   * escaped with {@linkcode xmlEscape} before returning it.
   *
   * ## Example
   *
   * ```js
   * getEntity(name) {
   *   if (name === "foo") {
   *     // Parsed as start tag 'bar', entity ref 'baz', end tag 'bar'
   *     return "<bar>&baz;</bar>";
   *   }
   *   if (name === "boo") {
   *     // Parsed as the literal text '<bar>&baz;</bar>'
   *     return xmlEscape("<bar>&baz;</bar>");
   *   }
   *   return undefined;
   * }
   * ```
   * @param name - Name of the entity.
   * @returns - Returns the replacement text of the specified entity.
   */
  getEntity(name: string): string | undefined;
}

export interface SaxOptions {
  /**
   * DTD handling mode. This private Hesperia parser supports only "prohibit".
   * A recognized DOCTYPE declaration throws ProhibitedDoctypeDecl.
   * Other runtime values throw TypeError.
   *
   * @defaultValue "prohibit"
   */
  dtd?: "prohibit" | undefined;
  /**
   * An entity provider for otherwise undeclared named entities.
   *
   * Entity values returned by the entity provider are not affected by the
   * {@linkcode dtd} option. This option is only recommended for limited,
   * trusted sets of entities.
   */
  entityProvider?: EntityProvider | undefined;
  /**
   * Emit {@linkcode SaxHandler.text} as soon as data becomes available.
   *
   * By default, the parser collects text content as it were forming a DOM Text
   * Node (or CDATA Section Node), even when text spans multiple chunks. This
   * makes the parser more predictable but delays output until the ending chunk
   * is reached.
   *
   * Enabling this option prevents any buffering and causes the parser to emit
   * {@linkcode SaxHandler.text} as soon as data becomes available.
   * @defaultValue false
   */
  incrementalText?: boolean | undefined;
  // Limiting the memory usage of the parser is one of, if not the, most
  // important security proofing step for XML.
  // https://web.archive.org/web/20240318075117/https://learn.microsoft.com/en-us/archive/msdn-magazine/2009/november/xml-denial-of-service-attacks-and-defenses
  /**
   * Maximum size allowed for the attributes in a single tag. Counts the total
   * combined length of names and values of attributes.
   * @defaultValue 10_000_000
   */
  maxAttributesLength?: number | undefined;
  /**
   * Maximum nesting depth allowed for elements.
   * @defaultValue 200
   */
  maxElementDepth?: number | undefined;
  /**
   * Maximum nesting depth allowed for entities.
   * @defaultValue 10
   */
  maxEntityDepth?: number | undefined;
  /**
   * Maximum size allowed for an entity value, including nested entities.
   * @defaultValue 1_000_000
   */
  maxEntityLength?: number | undefined;
  /**
   * Maximum size allowed for a markup identifier. Applies to tag and attribute
   * names.
   *
   * In {@linkcode SaxNamespaceParser}, it also applies to namespace URIs.
   * @defaultValue 2_000
   */
  maxNameLength?: number | undefined;
  /**
   * Maximum decoded length of a logical text run, in UTF-16 code units.
   *
   * Adjacent text, references and CDATA share a run across input chunks and
   * callbacks. Elements, comments and processing instructions end the run.
   * Attribute values are bounded separately. This limit also applies to
   * captured comments and processing instructions.
   * @defaultValue 10_000_000
   */
  maxTextLength?: number | undefined;
}

const enum State {
  INIT,
  XML_DECL,
  DOCTYPE_DECL_START,
  MISC,
  PI_TARGET_START,
  PI_TARGET,
  PI_CONTENT_START,
  PI_CONTENT,
  PI_CONTENT_END,
  PI_END,
  COMMENT_START,
  COMMENT,
  COMMENT_HYPHEN,
  COMMENT_END,
  OPEN_ANGLE_BRACKET,
  OPEN_ANGLE_BRACKET_BANG,
  START_TAG_NAME,
  START_TAG,
  START_TAG_SPACE,
  START_TAG_ATTR,
  START_TAG_ATTR_EQ,
  START_TAG_ATTR_VALUE,
  START_TAG_ATTR_VALUE_QUOTED,
  EMPTY_TAG,
  TEXT_CONTENT,
  REFERENCE,
  ENTITY_REF,
  CHAR_REF,
  CHAR_REF_DEC,
  CHAR_REF_HEX,
  CDATA_SECTION_START,
  CDATA_SECTION,
  CDATA_SECTION_END0,
  CDATA_SECTION_END,
  END_TAG_START,
  END_TAG,
  END_TAG_END,
}

// A bit of an abuse of const enum
/** @internal */
export const enum Flags {
  INIT = 0,

  // Option flags, these are turned on or off depending on SaxHandler and
  // SaxOptions and do not change as more input is read.

  // Capture Processing Instructions or ignore them.
  CAPTURE_PI = 1 << 0,
  // Capture Comments or ignore them.
  CAPTURE_COMMENT = 1 << 1,
  // These are boolean properties in SaxOptions
  OPT_INCREMENTAL_TEXT = 1 << 2,

  // Runtime flags:
  SEEN_ROOT = 1 << 3,
  STANDALONE = 1 << 5,
}

// Normalize XML line endings.
function normalizeLineEndings(s: string) {
  return s.replace(/\r\n?/g, "\n");
}

const enum EntityDecl {
  EXTERNAL = 1,
}

// Predefined entities are inserted as character data rather than parsed markup.
// https://www.w3.org/TR/REC-xml/#sec-predefined-ent
const PREDEFINED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"',
} as const;

export interface SaxParseOptions {
  /**
   * A boolean value indicating whether additional data follows in subsequent
   * calls to {@linkcode SaxParser.parse}. Set to `true` to process input in
   * chunks, and `false` for the final chunk or if the input is not chunked.
   * @defaultValue false
   */
  stream?: boolean | undefined;
}

/**
 * A streaming SAX-style XML parser.
 *
 * `SaxParser` processes input incrementally, notifying the provided
 * {@linkcode SaxHandler} of parsing events such as start tags, end tags and
 * text content. Because the parser does not construct a tree representation
 * of the document it is possible to process very large inputs efficiently.
 *
 * Malformed XML documents are not accepted, parsing errors cannot be recovered
 * from.
 *
 * For namespace-aware processing use {@linkcode SaxNamespaceParser} instead.
 *
 * @example
 * ```js
 * const parser = new SaxParser({
 *   startTag(name, attributes) {
 *     // Start tag: example
 *     // Start tag: empty-tag [attr, value]
 *     console.log("Start tag:", name, ...attributes);
 *   },
 *   endTag(name) {
 *     // End tag: example
 *     // End tag: empty-tag
 *     console.log("End tag:", name);
 *   },
 *   text(content) {
 *     // Text: Hello, world!
 *     console.log("Text:", content);
 *   },
 * });
 * parser.parse("<example>Hello, world!", {stream: true});
 * parser.parse(`<empty-tag attr="value" />`, {stream: true});
 * parser.parse("</example>");
 * ```
 *
 * @see {@linkcode SaxHandler}
 * @see {@linkcode SaxOptions}
 * @see {@linkcode SaxNamespaceHandler}
 * @see {@linkcode SaxNamespaceParser}
 */
export class SaxParser {
  // Reading this code requires knowledge of the XML standard and the JavaScript
  // string representation.
  // Code comments refer to the 16-bit JavaScript character unit as code unit.
  // Code point, Unicode character or just character refer instead to a Unicode
  // character including the full range of U+0000 to U+10FFFF.
  // Astral plane characters are fully supported (as required by the XML
  // standards) but `codePointAt` is avoided where possible as it is much
  // slower than `charCodeAt`.

  /** @internal */
  private handler_: SaxHandler;
  /** @internal */
  private entityProvider_: EntityProvider | undefined;

  // Options
  /** @internal */
  private maxAttributesLength_: number;
  /** @internal */
  private maxElementDepth_: number;
  /** @internal */
  private maxEntityDepth_: number;
  /** @internal */
  private maxEntityLength_: number;
  /** @internal */
  private maxNameLength_: number;
  /** @internal */
  private maxTextLength_: number;

  // State
  /** @internal */
  private chunk_ = "";
  /** @internal */
  private index_ = 0;
  /** @internal */
  private state_ = State.INIT;
  /** @internal */
  private otherState_ = 0;
  // Stores flags and boolean options.
  /** @internal */
  protected flags_ = Flags.INIT;
  /** @internal */
  private charRef_ = 0;
  /** @internal */
  private quote_ = -1;
  /** @internal */
  private entityLength_ = 0;
  // Decoded UTF-16 units across text callbacks, references and CDATA.
  /** @internal */
  private textLength_ = 0;
  // Total combined size of attribute names and values
  /** @internal */
  private attributesLength_ = 0;

  /** @internal */
  private elements_: string[] = [];

  // Stack of entities currently expanded, required for the WFC No Recursion and
  // to limit the depth of entity expansion allowed.
  /** @internal */
  private entityStack_: string[] = [];

  // Accumulators

  // Generic accumulator
  // Current element name
  /** @internal */
  private element_ = "";
  // Current text content, contains decoded and normalized content
  // or current attribute value
  /** @internal */
  private content_ = "";
  // Current attribute name
  /** @internal */
  private attribute_ = "";
  /** @internal */
  private entity_ = "";
  // Current attributes, this parser enforces well-formedness so an attribute
  // list cannot be avoided. To improve lookup times it uses a Map instead of a
  // plain object.
  /** @internal */
  private attributes_ = new Map<string, string>();

  // TODO: Namespace support?
  // readonly namespaces: ReadonlyMap<string, string>;
  // TODO: xml:space and xml:lang support?
  // /**
  //  * `xml:space` attribute.
  //  */
  // readonly xmlSpace?: "preserve" | "default" | undefined;
  // /**
  //  * `xml:lang` attribute.
  //  */
  // readonly xmlLang?: string | undefined;

  constructor(
    handler: SaxHandler,
    options: SaxOptions | undefined = undefined,
  ) {
    const opts = options ?? {};
    this.handler_ = handler;
    // Avoid capturing information that will be ignored
    if (this.handler_.processingInstruction != null) {
      this.flags_ |= Flags.CAPTURE_PI;
    }
    if (this.handler_.comment != null) {
      this.flags_ |= Flags.CAPTURE_COMMENT;
    }
    if (opts.incrementalText) {
      this.flags_ |= Flags.OPT_INCREMENTAL_TEXT;
    }
    const dtd: unknown = opts.dtd;

    if (dtd !== undefined && dtd !== "prohibit") {
      throw new TypeError(
        'Hesperia\'s private Saxe parser supports only dtd: "prohibit".',
      );
    }

    this.maxAttributesLength_ = opts.maxAttributesLength ?? 10_000_000;
    this.maxElementDepth_ = opts.maxElementDepth ?? 200;
    this.maxEntityDepth_ = opts.maxEntityDepth ?? 10;
    this.maxEntityLength_ = opts.maxEntityLength ?? 1_000_000;
    this.maxNameLength_ = opts.maxNameLength ?? 2_000;
    this.maxTextLength_ = opts.maxTextLength ?? 10_000_000;
    this.entityProvider_ = opts.entityProvider ?? undefined;
  }

  /**
   * Parses XML from `input` and notifies the handler of parsing events such as
   * start tags, end tags and text content.
   * @param input - A string containing the XML data to parse.
   * @param options -
   * @throws {@linkcode SaxError}
   */
  parse(
    input: string | undefined = undefined,
    options: SaxParseOptions | undefined = undefined,
  ) {
    if (input != null) {
      this.feed_(input);
    }
    if (!options?.stream) {
      if (this.state_ === State.INIT) {
        // Document is less than 6 characters long.
        this.state_ = State.MISC;
        this.feed_(this.element_);
      }
      if (
        this.elements_.length !== 0 ||
        this.state_ !== State.MISC ||
        !(this.flags_ & Flags.SEEN_ROOT)
      ) {
        throw new SaxError("UnexpectedEof");
      }
    }
  }

  /** @internal */
  private feed_(input: string) {
    this.chunk_ += input;
    // Ensure CRLF is handled correctly across chunk boundary
    const cr = this.chunk_.charCodeAt(this.chunk_.length - 1) === Chars.CR;
    if (cr) {
      this.chunk_ = this.chunk_.slice(0, -1);
    }
    while (this.index_ < this.chunk_.length) {
      this.parseStep_();
    }
    this.chunk_ = cr ? "\r" : "";
    this.index_ = 0;
  }
  // Strings are assumed to be well-formed, meaning they do not contain any
  // lone surrogates code units.
  /** @internal */
  private parseStep_() {
    switch (this.state_) {
      case State.INIT:
        return this.parseInit_();
      case State.XML_DECL:
        return this.parseXmlDecl_();
      // case State.XML_DECL_SPACE:
      //   return this.parseXmlDeclSpace_();
      // case State.XML_DECL_VALUE:
      //   return this.parseXmlDeclValue_();
      // case State.XML_DECL_VALUE_QUOTED:
      //   return this.parseXmlDeclValueQuoted_();
      // case State.XML_DECL_END:
      //   return this.parseXmlDeclEnd_();
      case State.DOCTYPE_DECL_START:
        return this.parseDoctypeDeclStart_();
      case State.MISC:
        return this.parseMisc_();
      case State.PI_TARGET_START:
        return this.parsePiTargetStart_();
      case State.PI_TARGET:
        return this.parsePiTarget_();
      case State.PI_CONTENT_START:
        return this.parsePiContentStart_();
      case State.PI_CONTENT:
        return this.parsePiContent_();
      case State.PI_CONTENT_END:
        return this.parsePiContentEnd_();
      case State.PI_END:
        return this.parsePiEnd_();
      case State.COMMENT_START:
        return this.parseCommentStart_();
      case State.COMMENT:
        return this.parseComment_();
      case State.COMMENT_HYPHEN:
        return this.parseCommentHyphen_();
      case State.COMMENT_END:
        return this.parseCommentEnd_();
      case State.OPEN_ANGLE_BRACKET:
        return this.parseOpenAngleBracket_();
      case State.OPEN_ANGLE_BRACKET_BANG:
        return this.parseOpenAngleBracketBang_();
      case State.START_TAG_NAME:
        return this.parseStartTagName_();
      case State.START_TAG:
        return this.parseStartTag_();
      case State.START_TAG_SPACE:
        return this.parseStartTagSpace_();
      case State.START_TAG_ATTR:
        return this.parseStartTagAttr_();
      case State.START_TAG_ATTR_EQ:
        return this.parseStartTagAttrEq_();
      case State.START_TAG_ATTR_VALUE:
        return this.parseStartTagAttrValue_();
      case State.START_TAG_ATTR_VALUE_QUOTED:
        return this.parseStartTagAttrValueQuoted_();
      case State.EMPTY_TAG:
        return this.parseEmptyTag_();
      case State.TEXT_CONTENT:
        return this.parseTextContent_();
      // &amp; &#38; general entity reference or character reference
      case State.REFERENCE:
        return this.parseReference_();
      case State.ENTITY_REF:
        return this.parseEntityRef_();
      case State.CHAR_REF:
        return this.parseCharRef_();
      // &#38;
      case State.CHAR_REF_DEC:
        return this.parseCharRefDec_();
      // &#x26;
      case State.CHAR_REF_HEX:
        return this.parseCharRefHex_();
      case State.CDATA_SECTION_START:
        return this.parseCDataSectionStart_();
      case State.CDATA_SECTION:
        return this.parseCDataSection_();
      case State.CDATA_SECTION_END0:
        return this.parseCDataSectionEnd0_();
      case State.CDATA_SECTION_END:
        return this.parseCDataSectionEnd_();
      case State.END_TAG_START:
        return this.parseEndTagStart_();
      case State.END_TAG:
        return this.parseEndTag_();
      case State.END_TAG_END:
        return this.parseEndTagEnd_();
    }
  }

  /** @internal */
  private parseInit_() {
    const newChunk = this.chunk_.slice(0, 6 - this.element_.length);
    this.element_ += newChunk;
    this.index_ += newChunk.length;
    // XMLDecl is "<?xml" SPACE, not checking for space could false positive on
    // a PI with a name that happens to start with xml.
    if (
      this.element_.length === 6 &&
      this.element_.slice(0, -1) === "<?xml" &&
      isWhiteSpace(this.element_.charCodeAt(5))
    ) {
      this.state_ = State.XML_DECL;
    } else if (this.element_.length === 6) {
      this.chunk_ = this.element_ + this.chunk_.slice(newChunk.length);
      this.index_ = 0;
      this.state_ = State.MISC;
      this.element_ = "";
    }
  }

  /** @internal */
  private parseXmlDecl_() {
    if (this.element_.charCodeAt(this.element_.length - 1) === Chars.QUESTION) {
      // Edge case, last chunk ended in ? so this chunk must start with >
      this.element_ += this.chunk_.charAt(this.index_);
      ++this.index_;
    } else {
      // Fast path: jump to the end of the XML Decl, we only search for ?
      // because we know the character after that is either a > or the document
      // is not well-formed.
      const question = this.chunk_.indexOf("?", this.index_);
      const end = question === -1 ? this.chunk_.length : question + 2;
      const chunk = this.chunk_.slice(this.index_, end);
      if (this.element_.length + (end - this.index_) > 2000) {
        throw new SaxError("LimitExceeded");
      }
      this.element_ += chunk;
      this.index_ = end;
      // XML Decl did not end in this chunk.
      if (question === -1 || end > this.chunk_.length) {
        return;
      }
    }
    const xmlDecl = parseXmlDecl(this.element_);
    // this.version_ = xmlDecl.version;
    // this.encoding_ = xmlDecl.encoding;
    if (xmlDecl.standalone) {
      this.flags_ |= Flags.STANDALONE;
    }
    this.handler_.xmlDecl?.(xmlDecl);
    this.state_ = State.MISC;
    this.element_ = "";
  }

  /** @internal */
  private parseDoctypeDeclStart_() {
    // No need to backtrack here, we know it's either DOCTYPE or fatal error
    const start = this.index_;
    this.index_ += 7 - this.element_.length;
    this.element_ += this.chunk_.slice(start, this.index_);
    this.index_ += 7 - this.element_.length;
    if (
      this.element_.slice(0, 6) === "OCTYPE" &&
      isWhiteSpace(this.element_.charCodeAt(6))
    ) {
      throw new SaxError("ProhibitedDoctypeDecl");
    } else if (this.element_.length === 7) {
      throw new SaxError("InvalidContent");
    }
  }

  // Allow namespace parser to override this
  /** @internal */
  protected checkNcName_(name: string) {
    void name;
  }

  /** @internal */
  private parseMisc_() {
    if (!this.skipWhiteSpace_()) {
      return;
    }
    if (this.chunk_.charCodeAt(this.index_) === Chars.LT) {
      ++this.index_;
      this.state_ = State.OPEN_ANGLE_BRACKET;
      this.otherState_ = State.MISC;
    } else {
      throw new SaxError("InvalidContent");
    }
  }

  /** @internal */
  private parsePiTargetStart_() {
    // codePointAt is fine here since we are not in a loop
    const codePoint = this.nextCodePoint_();
    if (isNameStartChar(codePoint)) {
      this.state_ = State.PI_TARGET;
      this.element_ = String.fromCodePoint(codePoint);
    } else {
      throw new SaxError("InvalidPi");
    }
  }

  /** @internal */
  private parsePiTarget_() {
    this.element_ += this.readNameCharacters_(this.element_.length);
    if (this.index_ < this.chunk_.length) {
      // Name read to completion
      this.checkNcName_(this.element_);
      if (this.element_.length === 3 && this.element_.toLowerCase() === "xml") {
        throw new SaxError("ReservedPi");
      }
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      ++this.index_;
      if (isWhiteSpace(codeUnit)) {
        this.state_ = State.PI_CONTENT_START;
      } else if (codeUnit === Chars.QUESTION) {
        this.state_ = State.PI_END;
      } else {
        throw new SaxError("InvalidPi");
      }
    }
  }

  /** @internal */
  private parsePiContentStart_() {
    if (this.skipWhiteSpace_()) {
      this.state_ = State.PI_CONTENT;
    }
  }

  /** @internal */
  private piEnd_() {
    if (this.flags_ & Flags.CAPTURE_PI) {
      this.handler_.processingInstruction?.(this.element_, this.content_);
    }
    this.element_ = "";
    this.content_ = "";
    this.state_ = this.otherState_;
    this.otherState_ = 0;
  }

  /** @internal */
  private parsePiContent_() {
    // All the searching is done with indexOf, basically a native strstr routine
    // which is much faster than anything that can be written manually in JS.
    const index = this.chunk_.indexOf("?>", this.index_);
    const content = this.chunk_.slice(
      this.index_,
      index === -1 ? undefined : index,
    );
    if (hasInvalidChar(content)) {
      throw new SaxError("InvalidChar");
    }
    if (this.flags_ & Flags.CAPTURE_PI) {
      const actualContent = normalizeLineEndings(content);
      if (this.content_.length + actualContent.length > this.maxTextLength_) {
        throw new SaxError("LimitExceeded");
      }
      this.content_ += actualContent;
    }
    if (index === -1) {
      this.index_ = this.chunk_.length;
      if (this.chunk_.charCodeAt(this.chunk_.length - 1) === Chars.QUESTION) {
        this.state_ = State.PI_CONTENT_END;
      }
    } else {
      this.index_ = index + 2;
      this.piEnd_();
    }
  }

  /** @internal */
  private parsePiContentEnd_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.GT) {
      this.content_ = this.content_.slice(0, -1);
      ++this.index_;
      this.piEnd_();
    } else {
      this.state_ = State.PI_CONTENT;
    }
  }

  /** @internal */
  private parsePiEnd_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.GT) {
      ++this.index_;
      this.piEnd_();
    } else {
      throw new SaxError("InvalidPi");
    }
  }

  /** @internal */
  private parseCommentStart_() {
    if (this.chunk_.charCodeAt(this.index_) !== Chars.HYPHEN) {
      throw new SaxError("InvalidContent");
    }
    ++this.index_;
    this.state_ = State.COMMENT;
  }

  /** @internal */
  private parseComment_() {
    // Same rationale behind parsePi_
    const index = this.chunk_.indexOf("--", this.index_);
    const content = this.chunk_.slice(
      this.index_,
      index === -1 ? undefined : index,
    );
    if (hasInvalidChar(content)) {
      throw new SaxError("InvalidChar");
    }
    if (this.flags_ & Flags.CAPTURE_COMMENT) {
      const actualContent = normalizeLineEndings(content);
      if (this.content_.length + actualContent.length > this.maxTextLength_) {
        throw new SaxError("LimitExceeded");
      }
      this.content_ += actualContent;
    }
    if (index === -1) {
      // Chunk is read to completion even on an ending hyphen, it will be
      // removed after the fact if the comment is ending.
      this.index_ = this.chunk_.length;
      // This chunk doesn't contain the end of this comment but it may contain
      // a trailing hyphen that has to be handled on the next chunk.
      if (this.chunk_.charCodeAt(this.chunk_.length - 1) === Chars.HYPHEN) {
        this.state_ = State.COMMENT_HYPHEN;
      }
    } else {
      this.index_ = index + 2;
      this.state_ = State.COMMENT_END;
    }
  }

  /** @internal */
  private parseCommentHyphen_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.HYPHEN) {
      // Content still contains the hyphen from the previous chunk.
      this.content_ = this.content_.slice(0, -1);
      ++this.index_;
      this.state_ = State.COMMENT_END;
    } else {
      this.state_ = State.COMMENT;
    }
  }

  /** @internal */
  private parseCommentEnd_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.GT) {
      ++this.index_;
      if (this.flags_ & Flags.CAPTURE_COMMENT) {
        this.handler_.comment?.(this.content_);
      }
      this.content_ = "";
      this.state_ = this.otherState_;
      this.otherState_ = 0;
    } else {
      throw new SaxError("InvalidComment");
    }
  }

  /** @internal */
  private parseOpenAngleBracket_() {
    const codePoint = this.nextCodePoint_();
    if (isNameStartChar(codePoint)) {
      this.textLength_ = 0;
      // Cannot have two root elements
      if (
        this.elements_.length === 0 &&
        this.entityStack_.length === 0 &&
        this.flags_ & Flags.SEEN_ROOT
      ) {
        throw new SaxError("InvalidStartTag");
      }
      if (this.elements_.length >= this.maxElementDepth_) {
        throw new SaxError("LimitExceeded");
      }
      this.element_ = String.fromCodePoint(codePoint);
      this.flags_ |= Flags.SEEN_ROOT;
      this.state_ = State.START_TAG_NAME;
    } else if (codePoint === Chars.SLASH) {
      this.textLength_ = 0;
      this.state_ = State.END_TAG_START;
    } else if (codePoint === Chars.BANG) {
      this.state_ = State.OPEN_ANGLE_BRACKET_BANG;
    } else if (codePoint === Chars.QUESTION) {
      this.textLength_ = 0;
      this.state_ = State.PI_TARGET_START;
    } else {
      throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private parseOpenAngleBracketBang_() {
    const codeUnit = this.chunk_.charCodeAt(this.index_);
    ++this.index_;
    if (codeUnit === Chars.HYPHEN) {
      this.textLength_ = 0;
      this.state_ = State.COMMENT_START;
    } else if (
      codeUnit === Chars.OPEN_BRACKET &&
      (this.elements_.length !== 0 || this.entityStack_.length !== 0)
    ) {
      this.state_ = State.CDATA_SECTION_START;
    } else if (codeUnit === 0x44 /* D */) {
      if (this.flags_ & Flags.SEEN_ROOT) {
        throw new SaxError("InvalidDoctypeDecl");
      }
      this.state_ = State.DOCTYPE_DECL_START;
    } else {
      throw new SaxError("InvalidContent");
    }
  }

  /** @internal */
  private startTagEnd_() {
    this.state_ = State.TEXT_CONTENT;
    this.otherState_ = 0;
    this.attributesLength_ = 0;
    const element = this.element_;
    const attributes = this.attributes_;
    this.element_ = "";
    this.attributes_ = new Map();
    this.elements_.push(element);
    this.handler_.startTag(element, attributes);
  }

  /** @internal */
  private parseStartTagName_() {
    this.element_ += this.readNameCharacters_(this.element_.length);
    if (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      ++this.index_;
      if (codeUnit === Chars.GT) {
        this.startTagEnd_();
      } else if (isWhiteSpace(codeUnit)) {
        this.state_ = State.START_TAG;
      } else if (codeUnit === Chars.SLASH) {
        this.state_ = State.EMPTY_TAG;
      } else {
        throw new SaxError("InvalidStartTag");
      }
    }
  }

  /** @internal */
  private parseStartTag_() {
    if (!this.skipWhiteSpace_()) {
      return;
    }
    const codePoint = this.nextCodePoint_();
    if (isNameStartChar(codePoint)) {
      this.state_ = State.START_TAG_ATTR;
      this.attribute_ = String.fromCodePoint(codePoint);
    } else if (codePoint === Chars.GT) {
      this.startTagEnd_();
    } else if (codePoint === Chars.SLASH) {
      this.state_ = State.EMPTY_TAG;
    } else {
      throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private parseStartTagSpace_() {
    const codeUnit = this.chunk_.charCodeAt(this.index_)!;
    ++this.index_;
    if (codeUnit === Chars.GT) {
      this.startTagEnd_();
    } else if (isWhiteSpace(codeUnit)) {
      this.state_ = State.START_TAG;
    } else if (codeUnit === Chars.SLASH) {
      this.state_ = State.EMPTY_TAG;
    } else {
      throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private parseStartTagAttr_() {
    this.attribute_ += this.readNameCharacters_(this.attribute_.length);
    if (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      ++this.index_;
      if (codeUnit === Chars.EQ) {
        // Most likely case
        this.state_ = State.START_TAG_ATTR_VALUE;
      } else if (isWhiteSpace(codeUnit)) {
        this.state_ = State.START_TAG_ATTR_EQ;
      } else {
        throw new SaxError("InvalidStartTag");
      }
    }
  }

  /** @internal */
  private parseStartTagAttrEq_() {
    if (!this.skipWhiteSpace_()) {
      return;
    }
    if (this.chunk_.charCodeAt(this.index_) === Chars.EQ) {
      ++this.index_;
      this.state_ = State.START_TAG_ATTR_VALUE;
    } else {
      throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private parseStartTagAttrValue_() {
    if (!this.skipWhiteSpace_()) {
      return;
    }
    const codeUnit = this.chunk_.charCodeAt(this.index_);
    switch (codeUnit) {
      case Chars.APOSTROPHE:
      case Chars.QUOTE:
        this.quote_ = codeUnit;
        ++this.index_;
        this.state_ = State.START_TAG_ATTR_VALUE_QUOTED;
        break;
      default:
        throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private parseStartTagAttrValueQuoted_() {
    const quote = this.quote_;
    let start = this.index_;
    loop: while (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      switch (codeUnit) {
        case Chars.TAB:
        case Chars.LF:
        case Chars.CR:
          this.appendContent_(start, this.maxTextLength_ - 1);
          this.content_ += " ";
          if (
            this.entityStack_.length === 0 &&
            codeUnit === Chars.CR &&
            this.chunk_.charCodeAt(this.index_ + 1) === Chars.LF
          ) {
            ++this.index_;
          }
          start = this.index_ + 1;
          break;
        case Chars.AMPERSAND:
          // TODO: this should be recursive for non-predefined general entity
          // references...
          this.state_ = State.REFERENCE;
          this.otherState_ = State.START_TAG_ATTR_VALUE_QUOTED;
          break loop;
        case quote: {
          this.appendContent_(start, this.maxTextLength_);
          ++this.index_;
          this.state_ = State.START_TAG_SPACE;
          if (this.attributes_.has(this.attribute_)) {
            throw new SaxError("AttributeRedefined", {
              attribute: this.attribute_,
            });
          }
          this.attributesLength_ += this.attribute_.length +
            this.content_.length;
          if (this.attributesLength_ > this.maxAttributesLength_) {
            throw new SaxError("LimitExceeded");
          }
          this.attributes_.set(this.attribute_, this.content_);
          this.attribute_ = "";
          this.content_ = "";
          return;
        }
        case Chars.LT:
          // < is not allowed inside attribute values
          throw new SaxError("InvalidAttributeValue");
        default:
          // Other characters still need to be validated:
          if (codeUnit < 0x20 || codeUnit > 0xfffd) {
            throw new SaxError("InvalidChar");
          }
      }
      ++this.index_;
    }
    this.appendContent_(start, this.maxTextLength_);
    ++this.index_;
  }

  /** @internal */
  private parseEmptyTag_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.GT) {
      ++this.index_;
      // Empty tags emit startTag and endTag right away
      const element = this.element_;
      this.startTagEnd_();
      this.handler_.endTag(element);
      this.elements_.pop();
      // Empty tag could still be the root element
      this.state_ =
        this.elements_.length === 0 && this.entityStack_.length === 0
          ? State.MISC
          : State.TEXT_CONTENT;
    } else {
      throw new SaxError("InvalidStartTag");
    }
  }

  /** @internal */
  private appendTextContent_(start: number) {
    this.appendText_(this.chunk_.slice(start, this.index_));
  }

  /** @internal */
  private appendText_(value: string) {
    const length = this.textLength_ + value.length;
    if (length > this.maxTextLength_) {
      throw new SaxError("LimitExceeded");
    }
    this.textLength_ = length;
    this.content_ += value;
  }

  /** @internal */
  private appendReference_(value: string) {
    if (this.otherState_ === State.TEXT_CONTENT) {
      this.appendText_(value);
    } else {
      if (this.content_.length + value.length > this.maxTextLength_) {
        throw new SaxError("LimitExceeded");
      }
      this.content_ += value;
    }
  }

  // This should ideally be somewhere else so that it can be applied to entities
  // This is the hottest part of the parser as most of an XML Document is text
  // content.
  /** @internal */
  private parseTextContent_() {
    let start = this.index_;
    // Due to having multiple exit points and error conditions, text content
    // can't be parsed using indexOf + regex validation.
    loop: while (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      switch (codeUnit) {
        case Chars.TAB:
        case Chars.LF:
          // TAB and LF are valid and since they are common, it's faster to
          // handle them here than in the default case
          // TODO: add significant whitespace handler?
          break;
        case Chars.CR:
          if (this.entityStack_.length === 0) {
            // Carriage return requires new-line normalization
            this.appendTextContent_(start);
            this.appendText_("\n");
            if (this.chunk_.charCodeAt(this.index_ + 1) === Chars.LF) {
              ++this.index_;
            }
            start = this.index_ + 1;
          }
          break;
        // State changing conditions:
        case Chars.AMPERSAND:
          // It was considered to handle references inline but they are not
          // common enough to justify doing more work here
          this.state_ = State.REFERENCE;
          this.otherState_ = State.TEXT_CONTENT;
          break loop;
        case Chars.LT:
          this.state_ = State.OPEN_ANGLE_BRACKET;
          this.otherState_ = State.TEXT_CONTENT;
          break loop;
        case Chars.GT:
          // Catch ]]>, this.otherState_ just stores the number of consecutive
          // brackets found.
          if (this.otherState_ > 1) {
            throw new SaxError("InvalidCDataEnd");
          }
          break;
        default:
          // Other characters still need to be validated:
          if (codeUnit < 0x20 || codeUnit > 0xfffd) {
            throw new SaxError("InvalidChar");
          }
      }
      if (codeUnit === Chars.CLOSE_BRACKET) {
        ++this.otherState_;
      } else {
        this.otherState_ = 0;
      }
      ++this.index_;
    }
    // By the time we get here, the chunk is finished or a special character was
    // reached.
    this.appendTextContent_(start);
    // Emit text content as needed
    if (
      this.content_ !== "" &&
      (this.state_ !== State.TEXT_CONTENT ||
        this.flags_ & Flags.OPT_INCREMENTAL_TEXT)
    ) {
      this.handler_.text(this.content_);
      this.content_ = "";
    }
    ++this.index_;
  }

  /** @internal */
  private parseReference_() {
    const codePoint = this.nextCodePoint_();
    if (isNameStartChar(codePoint)) {
      this.entity_ = String.fromCodePoint(codePoint);
      this.state_ = State.ENTITY_REF;
    } else if (codePoint === Chars.HASH) {
      this.state_ = State.CHAR_REF;
    } else {
      throw new SaxError("InvalidEntityRef");
    }
  }
  /** @internal */
  private parseEntityRef_() {
    this.entity_ += this.readNameCharacters_(this.entity_.length);
    if (this.index_ >= this.chunk_.length) {
      return;
    }
    this.checkNcName_(this.entity_);
    if (this.chunk_.charCodeAt(this.index_) !== Chars.SEMICOLON) {
      throw new SaxError("InvalidEntityRef");
    }
    ++this.index_;
    if (PREDEFINED_ENTITIES.hasOwnProperty(this.entity_)) {
      this.appendReference_(
        PREDEFINED_ENTITIES[this.entity_ as keyof typeof PREDEFINED_ENTITIES],
      );
    } else {
      // WFC: No Recursion
      if (this.entityStack_.indexOf(this.entity_) !== -1) {
        throw new SaxError("RecursiveEntity", {
          entity: this.entity_,
        });
      }

      // Preserve the external-entity sentinel rejection for JavaScript providers.
      const entityValue = this.flags_ & Flags.STANDALONE
        ? undefined
        : this.entityProvider_?.getEntity(this.entity_) as string | EntityDecl | undefined;

      if (entityValue == null || entityValue === EntityDecl.EXTERNAL) {
        // #22: Undeclared entities are not supported anymore. If applications
        // wish to recover they can return a default value in entity provider.
        throw new SaxError("UndeclaredEntity", {entity: this.entity_});
      }
      this.entityLength_ += entityValue.length;
      if (
        this.entityLength_ > this.maxEntityLength_ ||
        this.entityStack_.length >= this.maxEntityDepth_
      ) {
        throw new SaxError("LimitExceeded");
      }
      this.entityStack_.push(this.entity_);
      const index = this.index_;
      const chunk = this.chunk_;
      const quote = this.quote_;
      const elements = this.elements_;
      const otherState = this.otherState_;
      this.index_ = 0;
      this.chunk_ = "" + entityValue;
      this.quote_ = -1;
      this.elements_ = [];
      this.state_ = this.otherState_;
      this.otherState_ = 0;
      this.entity_ = "";
      while (this.index_ < this.chunk_.length) {
        this.parseStep_();
      }
      // https://www.w3.org/TR/REC-xml/#intern-replacement
      // [...] references MUST be contained entirely within the literal entity
      // value.
      // Entity value must match content production
      if (this.elements_.length !== 0 || this.state_ !== otherState) {
        throw new SaxError("UnexpectedEof");
      }
      this.entityStack_.pop();
      if (this.entityStack_.length === 0) {
        this.entityLength_ = 0;
      }
      this.index_ = index;
      this.chunk_ = chunk;
      this.quote_ = quote;
      this.elements_ = elements;
      this.otherState_ = this.state_;
    }
    this.state_ = this.otherState_;
    this.otherState_ = 0;
    this.entity_ = "";
  }

  /** @internal */
  private parseCharRef_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.LOWER_X) {
      ++this.index_;
      this.state_ = State.CHAR_REF_HEX;
    } else {
      this.state_ = State.CHAR_REF_DEC;
    }
  }

  /** @internal */
  private handleCharRef_() {
    // Skip semicolon ;
    ++this.index_;
    // TODO: 0 is not allowed so both explicit zero &#0; and zero size number
    //  &#; end up throwing here, but there's no way to know which one it is now
    if (!isChar(this.charRef_)) {
      throw new SaxError("InvalidCharRef");
    }
    this.appendReference_(String.fromCodePoint(this.charRef_));
    this.charRef_ = 0;
    this.state_ = this.otherState_;
    this.otherState_ = 0;
  }

  /** @internal */
  private parseCharRefDec_() {
    while (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      if (codeUnit === Chars.SEMICOLON) {
        this.handleCharRef_();
        break;
      }
      const digit = (codeUnit - 0x30) >>> 0;
      if (digit > 9) {
        throw new SaxError("InvalidCharRef");
      }
      this.charRef_ = this.charRef_ * 10 + digit;
      ++this.index_;
    }
  }

  /** @internal */
  private parseCharRefHex_() {
    while (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_);
      if (codeUnit === Chars.SEMICOLON) {
        this.handleCharRef_();
        break;
      }
      let digit = (codeUnit - 0x30) >>> 0;
      if (digit > 9) {
        digit = ((codeUnit | 0x20) - 0x57) >>> 0;
        if (digit < 10 || digit > 15) {
          throw new SaxError("InvalidCharRef");
        }
      }
      this.charRef_ = this.charRef_ * 16 + digit;
      ++this.index_;
    }
  }

  /** @internal */
  private parseCDataSectionStart_() {
    const start = this.index_;
    this.index_ += 6 - this.element_.length;
    this.element_ += this.chunk_.slice(start, this.index_);
    if (this.element_ === "CDATA[") {
      this.state_ = State.CDATA_SECTION;
      this.element_ = "";
      this.handler_.startCDataSection?.();
    } else if (this.element_.length === 6) {
      throw new SaxError("InvalidContent");
    }
  }

  /** @internal */
  private parseCDataSection_() {
    // Same rationale behind parsePi_
    const index = this.chunk_.indexOf("]]>", this.index_);
    let end = index === -1 ? this.chunk_.length : index;
    if (index === -1 && this.chunk_.charCodeAt(end - 1) === Chars.CLOSE_BRACKET) {
      // A chunk may end inside ]]>; defer those brackets until they are text.
      const pending = end - this.index_ > 1 &&
          this.chunk_.charCodeAt(end - 2) === Chars.CLOSE_BRACKET
        ? 2
        : 1;
      end -= pending;
      this.state_ = pending === 2
        ? State.CDATA_SECTION_END
        : State.CDATA_SECTION_END0;
    }
    const content = this.chunk_.slice(this.index_, end);
    if (hasInvalidChar(content)) {
      throw new SaxError("InvalidChar");
    }
    this.appendText_(normalizeLineEndings(content));
    if (index === -1) {
      this.index_ = this.chunk_.length;
      if (this.flags_ & Flags.OPT_INCREMENTAL_TEXT) {
        this.handler_.text(this.content_);
        this.content_ = "";
      }
    } else {
      this.index_ = index + 2;
      this.state_ = State.CDATA_SECTION_END;
    }
  }

  /** @internal */
  private parseCDataSectionEnd0_() {
    if (this.chunk_.charCodeAt(this.index_) === Chars.CLOSE_BRACKET) {
      ++this.index_;
      this.state_ = State.CDATA_SECTION_END;
    } else {
      this.appendText_("]");
      this.state_ = State.CDATA_SECTION;
    }
  }

  /** @internal */
  private parseCDataSectionEnd_() {
    const codeUnit = this.chunk_.charCodeAt(this.index_);
    if (codeUnit === Chars.GT) {
      ++this.index_;
      this.handler_.text(this.content_);
      this.handler_.endCDataSection?.();
      this.state_ = State.TEXT_CONTENT;
      this.otherState_ = 0;
      this.content_ = "";
    } else if (codeUnit === Chars.CLOSE_BRACKET) {
      ++this.index_;
      this.appendText_("]");
    } else {
      this.appendText_("]]");
      this.state_ = State.CDATA_SECTION;
    }
  }

  /** @internal */
  private parseEndTagStart_() {
    const codePoint = this.nextCodePoint_();
    if (isNameStartChar(codePoint)) {
      this.state_ = State.END_TAG;
      this.element_ = String.fromCodePoint(codePoint);
    } else {
      throw new SaxError("InvalidEndTag");
    }
  }

  /** @internal */
  private parseEndTag_() {
    this.element_ += this.readNameCharacters_(this.element_.length);
    if (this.index_ < this.chunk_.length) {
      this.state_ = State.END_TAG_END;
    }
  }

  /** @internal */
  private parseEndTagEnd_() {
    if (!this.skipWhiteSpace_()) {
      return;
    }
    const codeUnit = this.chunk_.charCodeAt(this.index_);
    if (codeUnit !== Chars.GT) {
      throw new SaxError("InvalidEndTag");
    }
    if (this.elements_.pop() !== this.element_) {
      throw new SaxError("TagNameMismatch", {element: this.element_});
    }
    ++this.index_;
    this.state_ = this.elements_.length === 0 && this.entityStack_.length === 0
      ? State.MISC
      : State.TEXT_CONTENT;
    this.otherState_ = 0;
    const element = this.element_;
    this.element_ = "";
    this.handler_.endTag(element);
  }

  // Internal functions

  /** @internal */
  private appendContent_(start: number, limit: number) {
    const chunk = this.chunk_.slice(start, this.index_);
    if (this.content_.length + chunk.length > limit) {
      throw new SaxError("LimitExceeded");
    }
    this.content_ += chunk;
  }

  /** @internal */
  private nextCodePoint_() {
    let codePoint = this.chunk_.charCodeAt(this.index_);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      // https://unicode.org/faq/utf_bom.html#utf16-3
      codePoint = (codePoint << 10) + this.chunk_.charCodeAt(++this.index_) -
        0x35fdc00;
    }
    ++this.index_;
    return codePoint;
  }

  /** @internal */
  private readNameCharacters_(length: number) {
    const start = this.index_;
    while (this.index_ < this.chunk_.length) {
      const codeUnit = this.chunk_.charCodeAt(this.index_)!;
      if (!isNameChar(codeUnit)) {
        // codeUnit now is either an invalid code point or a leading surrogate
        // of a valid or invalid code point.
        // Trick: only limitation on astral code points is they have to be less
        // than or equal to U+EFFFF, since we assume all strings are well-formed
        // UTF-16, surrogates are known to be valid.
        // Leading surrogate value is the only significant value to determine
        // that the code point is in range -- restricted to 0x3BF (most
        // significant 11 bits of 0xEFFFF) plus leading surrogate offset 0xD7C0.
        // For our assumptions the following code unit is known to be a trailing
        // surrogate character with the lower 10 bits of the code point which
        // are irrelevant for the range check.
        if (codeUnit >= 0xd800 && codeUnit <= 0xdb7f) {
          // codeUnit is the leading surrogate of a valid astral code point
          ++this.index_;
        } else {
          // codeUnit is an invalid code point or the leading surrogate of an
          // invalid astral code point
          break;
        }
      }
      ++this.index_;
    }
    const name = this.chunk_.slice(start, this.index_);
    if (length + name.length > this.maxNameLength_) {
      throw new SaxError("LimitExceeded");
    }
    return name;
  }

  /** @internal */
  private skipWhiteSpace_() {
    while (this.index_ < this.chunk_.length) {
      if (!isWhiteSpace(this.chunk_.charCodeAt(this.index_))) {
        break;
      }
      ++this.index_;
    }
    return this.index_ !== this.chunk_.length;
  }
}
