import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\]+/g;

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string, context?: ResolveContext): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	resolveContext?: ResolveContext;
	localOptions?: LocalProtocolOptions;
	ensureLocalParentDirs?: boolean;
}

interface TextRange {
	start: number;
	end: number;
}

interface HeredocDelimiter {
	text: string;
	stripLeadingTabs: boolean;
}

interface ParsedHeredocWord {
	delimiter: string;
	end: number;
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Does NOT read file content or verify existence.
 */
export function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): string {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return path.resolve(skill.filePath);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(message);
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}

	return resolvedPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

function readLineRange(text: string, start: number): { start: number; contentEnd: number; end: number } {
	const newlineIndex = text.indexOf("\n", start);
	const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
	const contentEnd =
		newlineIndex === -1 ? text.length : text.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex;
	return { start, contentEnd, end };
}

function isShellWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t";
}

function isHeredocWordTerminator(ch: string): boolean {
	return (
		isShellWhitespace(ch) ||
		ch === ";" ||
		ch === "&" ||
		ch === "|" ||
		ch === "<" ||
		ch === ">" ||
		ch === "(" ||
		ch === ")"
	);
}

function parseHeredocWord(command: string, start: number, end: number): ParsedHeredocWord | undefined {
	let i = start;
	let delimiter = "";

	while (i < end) {
		const ch = command[i];
		if (isHeredocWordTerminator(ch)) break;

		if (ch === "'") {
			i++;
			while (i < end) {
				const quoted = command[i];
				if (quoted === "'") {
					i++;
					break;
				}
				delimiter += quoted;
				i++;
			}
			continue;
		}

		if (ch === '"') {
			i++;
			while (i < end) {
				const quoted = command[i];
				if (quoted === '"') {
					i++;
					break;
				}
				if (quoted === "\\" && i + 1 < end) {
					delimiter += command[i + 1];
					i += 2;
					continue;
				}
				delimiter += quoted;
				i++;
			}
			continue;
		}

		if (ch === "\\" && i + 1 < end) {
			delimiter += command[i + 1];
			i += 2;
			continue;
		}

		delimiter += ch;
		i++;
	}

	if (!delimiter) return undefined;
	return { delimiter, end: i };
}

function collectHeredocsFromShellLine(
	command: string,
	start: number,
	end: number,
): {
	delimiters: HeredocDelimiter[];
	ignoredRanges: TextRange[];
} {
	const delimiters: HeredocDelimiter[] = [];
	const ignoredRanges: TextRange[] = [];
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = start; i < end; i++) {
		const ch = command[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (!singleQuoted && ch === "\\") {
			escaped = true;
			continue;
		}

		if (!doubleQuoted && ch === "'") {
			singleQuoted = !singleQuoted;
			continue;
		}

		if (!singleQuoted && ch === '"') {
			doubleQuoted = !doubleQuoted;
			continue;
		}

		if (singleQuoted || doubleQuoted) continue;

		if (ch === "#" && (i === start || isShellWhitespace(command[i - 1]))) break;

		if (ch !== "<" || command[i + 1] !== "<" || command[i + 2] === "<") continue;

		let cursor = i + 2;
		const stripLeadingTabs = command[cursor] === "-";
		if (stripLeadingTabs) cursor++;
		while (cursor < end && isShellWhitespace(command[cursor])) cursor++;

		const parsed = parseHeredocWord(command, cursor, end);
		if (!parsed) continue;

		ignoredRanges.push({ start: cursor, end: parsed.end });
		delimiters.push({ text: parsed.delimiter, stripLeadingTabs });
		i = parsed.end - 1;
	}

	return { delimiters, ignoredRanges };
}

function heredocDelimiterMatches(
	command: string,
	lineStart: number,
	contentEnd: number,
	delimiter: HeredocDelimiter,
): boolean {
	let start = lineStart;
	if (delimiter.stripLeadingTabs) {
		while (start < contentEnd && command[start] === "\t") start++;
	}
	return command.slice(start, contentEnd) === delimiter.text;
}

function collectHeredocIgnoredRanges(command: string): TextRange[] {
	if (!command.includes("<<")) return [];

	const ranges: TextRange[] = [];
	const pendingDelimiters: HeredocDelimiter[] = [];
	let offset = 0;

	while (offset < command.length) {
		while (pendingDelimiters.length > 0 && offset < command.length) {
			const delimiter = pendingDelimiters.shift();
			if (!delimiter) break;

			const bodyStart = offset;
			let foundDelimiter = false;
			while (offset < command.length) {
				const line = readLineRange(command, offset);
				offset = line.end;
				if (heredocDelimiterMatches(command, line.start, line.contentEnd, delimiter)) {
					ranges.push({ start: bodyStart, end: line.end });
					foundDelimiter = true;
					break;
				}
			}
			if (!foundDelimiter) {
				ranges.push({ start: bodyStart, end: command.length });
			}
		}

		if (offset >= command.length) break;

		const line = readLineRange(command, offset);
		const { delimiters, ignoredRanges } = collectHeredocsFromShellLine(command, line.start, line.contentEnd);
		ranges.push(...ignoredRanges);
		pendingDelimiters.push(...delimiters);
		offset = line.end;
	}

	return ranges;
}

function overlapsRange(start: number, end: number, ranges: readonly TextRange[]): boolean {
	for (const range of ranges) {
		if (end <= range.start) return false;
		if (start < range.end && end > range.start) return true;
	}
	return false;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	internalRouter?: InternalUrlResolver,
	resolveContext?: ResolveContext,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		return resolveSkillUrlToPath(url, skills);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });
		}
		return resolvedLocalPath;
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url, resolveContext);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand all skill:// URIs in a bash command string.
 * Returns the command with URIs replaced by shell-escaped absolute paths.
 * Throws ToolError if any URI cannot be resolved.
 */
export function expandSkillUrls(command: string, skills: readonly Skill[]): string {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	const ignoredRanges = collectHeredocIgnoredRanges(command);
	return command.replace(SKILL_URL_PATTERN, (token, index: number) => {
		if (overlapsRange(index, index + token.length, ignoredRanges)) return token;
		const url = unquoteToken(token);
		const resolvedPath = resolveSkillUrlToPath(url, skills);
		return shellEscape(resolvedPath);
	});
}

/**
 * Expand supported internal URLs in a bash command string to shell-escaped absolute paths.
 * Supported schemes: skill://, agent://, artifact://, memory://, rule://, local://
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const ignoredRanges = collectHeredocIgnoredRanges(command);
	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL)).filter(match => {
		const index = match.index;
		if (index === undefined) return false;
		return !overlapsRange(index, index + match[0].length, ignoredRanges);
	});
	if (matches.length === 0) return command;

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		const resolvedPath = await resolveInternalUrlToPath(
			url,
			options.skills,
			options.internalRouter,
			options.resolveContext,
			options.localOptions,
			options.ensureLocalParentDirs,
		);
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
