(function (root, factory) {
    if (typeof exports === 'object') {
        // CommonJS
        factory(exports, require('underscore'), require("es6-collections"),
                require("./parser"), require("./expander"), require("./syntax"));
    } else if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['exports', 'underscore', 'es6-collections',
                'parser', 'expander', 'syntax'], factory);
    }
}(this, function(exports, _, es6, parser, expander, syntax) {

    var get_expression = expander.get_expression;
    var syntaxFromToken = syntax.syntaxFromToken;
    var makePunc = syntax.makePunc;
    var joinSyntax = syntax.joinSyntax;
    var joinSyntaxArr = syntax.joinSyntaxArr;
    var assert = syntax.assert;
    var throwSyntaxError = syntax.throwSyntaxError;

    var push = Array.prototype.push;


    // ([...CSyntax]) -> [...Str]
    function freeVarsInPattern(pattern) {
        var fv = [];

        _.each(pattern, function (pat) {
            if (isPatternVar(pat)) {
                fv.push(pat.token.value);
            } else if (pat.token.type === parser.Token.Delimiter) {
                push.apply(fv, freeVarsInPattern(pat.token.inner));
            }
        });

        return fv;
    }

    
    function typeIsLiteral (type) {
        return type === parser.Token.NullLiteral ||
               type === parser.Token.NumericLiteral ||
               type === parser.Token.StringLiteral ||
               type === parser.Token.RegexLiteral ||
               type === parser.Token.BooleanLiteral;
    }

    function containsPatternVar(patterns) {
        return _.any(patterns, function(pat) {
            if (pat.token.type === parser.Token.Delimiter) {
                return containsPatternVar(pat.token.inner);
            }
            return isPatternVar(pat);
        });
    }

    function delimIsSeparator(delim) {
        return (delim && delim.token && delim.token.type === parser.Token.Delimiter &&
                delim.token.value === "()" &&
                delim.token.inner.length === 1 &&
                delim.token.inner[0].token.type !== parser.Token.Delimiter &&
                !containsPatternVar(delim.token.inner));
    }

    function isPatternVar(stx) {
        return stx.token.value[0] === "$" && stx.token.value !== "$";        
    }


    // ([...{level: Num, match: [...CSyntax]}], Str) -> [...CSyntax]
    function joinRepeatedMatch(tojoin, punc) {
        return _.reduce(_.rest(tojoin, 1), function(acc, join) {
            if (punc === " ") {
                return acc.concat(join.match);
            }
            return acc.concat(makePunc(punc, _.first(join.match)),
                              join.match);
        }, _.first(tojoin).match);
    }
    
    // take the line context (range, lineNumber)
    // (CSyntax, [...CSyntax]) -> [...CSyntax]
    function takeLineContext(from, to) {
        return _.map(to, function(stx) {
            return takeLine(from, stx);
        });
    }

    // (CSyntax, CSyntax) -> CSyntax
    function takeLine(from, to) {
        var next;
        if (to.token.type === parser.Token.Delimiter) {
            if (from.token.type === parser.Token.Delimiter) {
                next = syntaxFromToken({
                    type: parser.Token.Delimiter,
                    value: to.token.value,
                    inner: takeLineContext(from, to.token.inner),
                    startRange: from.token.startRange,
                    endRange: from.token.endRange,
                    startLineNumber: from.token.startLineNumber,
                    startLineStart: from.token.startLineStart,
                    endLineNumber: from.token.endLineNumber,
                    endLineStart: from.token.endLineStart,
                    sm_startLineNumber: to.token.startLineNumber,
                    sm_endLineNumber: to.token.endLineNumber,
                    sm_startLineStart: to.token.startLineStart,
                    sm_endLineStart: to.token.endLineStart,
                    sm_startRange: to.token.startRange,
                    sm_endRange: to.token.endRange
                }, to);

            } else {
                next = syntaxFromToken({
                    type: parser.Token.Delimiter,
                    value: to.token.value,
                    inner: takeLineContext(from, to.token.inner),
                    startRange: from.token.range,
                    endRange: from.token.range,
                    startLineNumber: from.token.lineNumber,
                    startLineStart: from.token.lineStart,
                    endLineNumber: from.token.lineNumber,
                    endLineStart: from.token.lineStart,
                    sm_startLineNumber: to.token.startLineNumber,
                    sm_endLineNumber: to.token.endLineNumber,
                    sm_startLineStart: to.token.startLineStart,
                    sm_endLineStart: to.token.endLineStart,
                    sm_startRange: to.token.startRange,
                    sm_endRange: to.token.endRange
                }, to);
            }
        } else {
            if (from.token.type === parser.Token.Delimiter) {
                next = syntaxFromToken({
                    value: to.token.value,
                    type: to.token.type,
                    lineNumber: from.token.startLineNumber,
                    lineStart: from.token.startLineStart,
                    range: from.token.startRange,
                    sm_lineNumber: to.token.lineNumber,
                    sm_lineStart: to.token.lineStart,
                    sm_range: to.token.range
                }, to);
            } else {
                next = syntaxFromToken({
                    value: to.token.value,
                    type: to.token.type,
                    lineNumber: from.token.lineNumber,
                    lineStart: from.token.lineStart,
                    range: from.token.range,
                    sm_lineNumber: to.token.lineNumber,
                    sm_lineStart: to.token.lineStart,
                    sm_range: to.token.range
                }, to);
            }
        }
        if (to.token.leadingComments) {
            next.token.leadingComments = to.token.leadingComments;
        }
        if (to.token.trailingComments) {
            next.token.trailingComments = to.token.trailingComments;
        }
        return next;
    }

    function reversePattern(patterns) {
        var len = patterns.length;
        var pat;
        return _.reduceRight(patterns, function(acc, pat) {
            if (pat.class === "pattern_group") {
                pat.token.inner = reversePattern(pat.token.inner);
            }
            if (pat.repeat) {
                pat.leading = !pat.leading;
            }
            acc.push(pat);
            return acc;
        }, []);
    }

    function loadLiteralGroup(patterns) {
        _.forEach(patterns, function(patStx) {
            if (patStx.token.type === parser.Token.Delimiter) {
                patStx.token.inner = loadLiteralGroup(patStx.token.inner);
            } else {
                patStx.class = "pattern_literal";
            }
        });
        return patterns;
    }

    function loadPattern(patterns, reverse) {
        var patts = _.chain(patterns)
        // first pass to merge the pattern variables together
            .reduce(function(acc, patStx, idx) {
                var last = patterns[idx-1];
                var lastLast = patterns[idx-2];
                var next = patterns[idx+1];
                var nextNext = patterns[idx+2];

                // skip over the `:lit` part of `$x:lit`
                if (patStx.token.value === ":") {
                    if(last && isPatternVar(last) && !isPatternVar(next)) {
                        return acc;
                    }
                }
                if (last && last.token.value === ":") {
                    if (lastLast && isPatternVar(lastLast) && !isPatternVar(patStx)) {
                        return acc;
                    }
                }
                // skip over $
                if (patStx.token.value === "$" &&
                    next && next.token.type === parser.Token.Delimiter) {
                    return acc;
                }

                if (isPatternVar(patStx)) {
                    if (next && next.token.value === ":" && !isPatternVar(nextNext)) {
                        if (typeof nextNext === 'undefined') {
                            throwSyntaxError("patterns", "expecting a pattern class following a `:`", next);
                        }
                        patStx.class = nextNext.token.value;
                    } else {
                        patStx.class = "token";
                    }
                } else if (patStx.token.type === parser.Token.Delimiter) {
                    if (last && last.token.value === "$") {
                        patStx.class = "pattern_group";
                    }

                    // Leave literal groups as is
                    if (patStx.class === "pattern_group" && patStx.token.value === '[]') {
                        patStx.token.inner = loadLiteralGroup(patStx.token.inner);
                    } else {
                        patStx.token.inner = loadPattern(patStx.token.inner);
                    }
                } else {
                    patStx.class = "pattern_literal";
                }
                acc.push(patStx);
                return acc;
                // then second pass to mark repeat and separator
            }, []).reduce(function(acc, patStx, idx, patterns) {
                var separator = patStx.separator || " ";
                var repeat = patStx.repeat || false;
                var next = patterns[idx+1];
                var nextNext = patterns[idx+2];

                if (next && next.token.value === "...") {
                    repeat = true;
                    separator = " ";
                } else if (delimIsSeparator(next) &&
                           nextNext && nextNext.token.value === "...") {
                    repeat = true;
                    assert(next.token.inner.length === 1,
                           "currently assuming all separators are a single token");
                    separator = next.token.inner[0].token.value;
                }

                // skip over ... and (,)
                if (patStx.token.value === "..."||
                    (delimIsSeparator(patStx) && next && next.token.value === "...")) {
                    return acc;
                }
                patStx.repeat = repeat;
                patStx.separator = separator;
                acc.push(patStx);
                return acc;
            }, []).value();

        return reverse ? reversePattern(patts) : patts;
    }

    function cachedTermMatch(stx, term) {
        var res = [];
        var i = 0;
        while (stx[i] && stx[i].term === term) {
            res.unshift(stx[i]);
            i++;
        }
        return {
            result: term,
            destructed: res,
            rest: stx.slice(res.length)
        };
    }


    // (Str, [...CSyntax], MacroEnv) -> {result: null or [...CSyntax], rest: [...CSyntax]}
    function matchPatternClass (patternClass, stx, env) {
        var result, rest, match;
        // pattern has no parse class
        if (patternClass === "token" &&
            stx[0] && stx[0].token.type !== parser.Token.EOF) {
            result = [stx[0]];
            rest = stx.slice(1);
        } else if (patternClass === "lit" &&
                   stx[0] && typeIsLiteral(stx[0].token.type)) {
            result = [stx[0]];
            rest = stx.slice(1);
        } else if (patternClass === "ident" &&
                   stx[0] && stx[0].token.type === parser.Token.Identifier) {
            result = [stx[0]];
            rest = stx.slice(1);
        } else if (stx.length > 0 && patternClass === "VariableStatement") {
            match = stx[0].term
                ? cachedTermMatch(stx, stx[0].term)
                : expander.enforest(stx, expander.makeExpanderContext({env: env}));
            if (match.result && match.result.hasPrototype(expander.VariableStatement)) {
                result = match.destructed || match.result.destruct(false);
                rest = match.rest;
            } else {
                result = null;
                rest = stx;
            }
        } else if (stx.length > 0 && patternClass === "expr") {
            match = stx[0].term
                ? cachedTermMatch(stx, stx[0].term)
                : expander.get_expression(stx, expander.makeExpanderContext({env: env}));
            if (match.result === null || (!match.result.hasPrototype(expander.Expr))) {
                result = null;
                rest = stx;
            } else {
                result = match.destructed || match.result.destruct(false);
                rest = match.rest;
            }
        } else {
            result = null;
            rest = stx;
        }

        return {
            result: result,
            rest: rest
        };
    }

    
    // attempt to match patterns against stx
    // ([...Pattern], [...Syntax], Env) -> { result: [...Syntax], rest: [...Syntax], patternEnv: PatternEnv }
    function matchPatterns(patterns, stx, env, topLevel) {
        // topLevel lets us know if the patterns are on the top level or nested inside
        // a delimiter:
        //     case $topLevel (,) ... => { }
        //     case ($nested (,) ...) => { }
        // This matters for how we deal with trailing unmatched syntax when the pattern
        // has an ellipses:
        //     m 1,2,3 foo
        // should match 1,2,3 and leave foo alone but:
        //     m (1,2,3 foo)
        // should fail to match entirely.
        topLevel = topLevel || false;
        // note that there are two environments floating around,
        // one is the mapping of identifiers to macro definitions (env)
        // and the other is the pattern environment (patternEnv) that maps
        // patterns in a macro case to syntax.
        var result = [];
        var patternEnv = {};

        var match;
        var pattern;
        var rest = stx;
        var success = true;
        var inLeading;

        patternLoop:
        for (var i = 0; i < patterns.length; i++) {
            if (success === false) {
                break;
            }
            pattern = patterns[i];
            inLeading = false;
            do {
                // handles cases where patterns trail a repeated pattern like `$x ... ;`
                if (pattern.repeat && i + 1 < patterns.length) {
                    var restMatch = matchPatterns(patterns.slice(i+1), rest, env, topLevel);
                    if (restMatch.success) {
                        // match the repeat pattern on the empty array to fill in its
                        // pattern variable in the environment 
                        match = matchPattern(pattern, [], env, patternEnv);
                        patternEnv = _.extend(restMatch.patternEnv, match.patternEnv);
                        rest = restMatch.rest;
                        break patternLoop;
                    }
                }
                if (pattern.repeat && pattern.leading && pattern.separator !== " ") {
                    if (rest[0].token.value === pattern.separator) {
                        if (!inLeading) {
                            inLeading = true;
                        }
                        rest = rest.slice(1);
                    } else {
                        // If we are in a leading repeat, the separator is required.
                        if (inLeading) {
                            success = false;
                            break;
                        }
                    }
                }
                match = matchPattern(pattern, rest, env, patternEnv);
                if (!match.success && pattern.repeat) {
                    // a repeat can match zero tokens and still be a
                    // "success" so break out of the inner loop and
                    // try the next pattern
                    break;
                }
                if (!match.success) {
                    success = false;
                    break;
                }
                rest = match.rest;
                patternEnv = match.patternEnv;

                if (success && !(topLevel || pattern.repeat)) {
                    // the very last pattern matched, inside a
                    // delimiter, not a repeat, *and* there are more
                    // unmatched bits of syntax
                    if (i == (patterns.length - 1) && rest.length !== 0) {
                        success = false;
                        break;
                    }
                }

                if (pattern.repeat && !pattern.leading && success) {
                    // if (i < patterns.length - 1 && rest.length > 0) {
                    //     var restMatch = matchPatterns(patterns.slice(i+1), rest, env, topLevel);
                    //     if (restMatch.success) {
                    //         patternEnv = _.extend(patternEnv, restMatch.patternEnv);
                    //         rest = restMatch.rest;
                    //         break patternLoop;
                    //     }
                    // }

                    if (pattern.separator === " ") {
                        // no separator specified (using the empty string for this)
                        // so keep going
                        continue;
                    } else if (rest[0] && rest[0].token.value === pattern.separator) {
                        // more tokens and the next token matches the separator
                        rest = rest.slice(1);
                    } else if ((pattern.separator !== " ") &&
                                (rest.length > 0) &&
                                (i === patterns.length - 1) &&
                                topLevel === false) {
                        // separator is specified, there is a next token, the
                        // next token doesn't match the separator, there are
                        // no more patterns, and this is a top level pattern
                        // so the match has failed
                        success = false;
                        break;
                    } else {
                        break;
                    }
                }
            } while (pattern.repeat && success && rest.length > 0);
        }

        var result;
        if (success) {
            result = rest.length ? stx.slice(0, -rest.length): stx;
        } else {
            result = [];
        }

        return {
            success: success,
            result: result,
            rest: rest,
            patternEnv: patternEnv
        };
    }

    
    /* the pattern environment will look something like:
    {
        "$x": {
            level: 2,
            match: [{
                level: 1,
                match: [{
                    level: 0,
                    match: [tok1, tok2, ...]
                }, {
                    level: 0,
                    match: [tok1, tok2, ...]
                }]
            }, {
                level: 1,
                match: [{
                    level: 0,
                    match: [tok1, tok2, ...]
                }]
            }]
        },
        "$y" : ...
    }
    */
    function matchPattern(pattern, stx, env, patternEnv) {
        var subMatch;
        var match, matchEnv;
        var rest;
        var success;

        if (typeof pattern.inner !== 'undefined') {
            if (pattern.class === "pattern_group") {
                // pattern groups don't match the delimiters
                subMatch = matchPatterns(pattern.inner, stx, env, true);
                rest = subMatch.rest;
            } else if (stx[0] && stx[0].token.type === parser.Token.Delimiter &&
                       stx[0].token.value === pattern.value) {
                stx[0].expose();
                if (pattern.inner.length === 0 && stx[0].token.inner.length !== 0) {
                    return {
                        success: false,
                        rest: stx,
                        patternEnv: patternEnv
                    }
                }
                subMatch = matchPatterns(pattern.inner,
                                         stx[0].token.inner,
                                         env,
                                         false);
                rest = stx.slice(1);
            } else {
                return {
                    success: false,
                    rest: stx,
                    patternEnv: patternEnv
                };
            }
            success = subMatch.success;

            // merge the subpattern matches with the current pattern environment
            _.keys(subMatch.patternEnv).forEach(function(patternKey) {
                if (pattern.repeat) {
                    // if this is a repeat pattern we need to bump the level
                    var nextLevel = subMatch.patternEnv[patternKey].level + 1;

                    if (patternEnv[patternKey]) {
                        patternEnv[patternKey].level = nextLevel;
                        patternEnv[patternKey].match.push(subMatch.patternEnv[patternKey]);
                    } else {
                        // initialize if we haven't done so already
                        patternEnv[patternKey] = {
                            level: nextLevel,
                            match: [subMatch.patternEnv[patternKey]]
                        };
                    }
                } else {
                    // otherwise accept the environment as-is
                    patternEnv[patternKey] = subMatch.patternEnv[patternKey];
                }
            });

        } else {
            if (pattern.class === "pattern_literal") {
                // wildcard
                if(stx[0] && pattern.value === "_") {
                    success = true;
                    rest = stx.slice(1);
                // match the literal but don't update the pattern environment
                } else if (stx[0] && pattern.value === stx[0].token.value) {
                    success = true;
                    rest = stx.slice(1);
                } else {
                    success = false;
                    rest = stx;
                }
            } else {
                match = matchPatternClass(pattern.class, stx, env);

                success = match.result !== null;
                rest = match.rest;
                matchEnv = {
                    level: 0,
                    match: match.result
                };

                // push the match onto this value's slot in the environment
                if (pattern.repeat) {
                    if (patternEnv[pattern.value] && success) {
                        patternEnv[pattern.value].match.push(matchEnv);
                    } else if (patternEnv[pattern.value] === undefined){
                        // initialize if necessary
                        patternEnv[pattern.value] = {
                            level: 1,
                            match: [matchEnv]
                        };
                    }
                } else {
                    patternEnv[pattern.value] = matchEnv;
                }
            }
        }
        return {
            success: success,
            rest: rest,
            patternEnv: patternEnv
        };

    }

    function matchLookbehind(patterns, stx, terms, env) {
        var success, patternEnv, prevStx, prevTerms;
        // No lookbehind, noop.
        if (!patterns.length) {
            success = true;
            patternEnv = {};
            prevStx = stx;
            prevTerms = terms;
        } else {
            var match = matchPatterns(patterns, stx, env, true);
            var last = match.result[match.result.length - 1];
            success = match.success;
            patternEnv = match.patternEnv;
            if (success) {
                if (match.rest.length) {
                    if (last && last.term === match.rest[0].term) {
                        // The term tree was split, so its a failed match;
                        success = false;
                    } else {
                        prevStx = match.rest;
                        // Find where to slice the prevTerms to match up with
                        // the state of prevStx.
                        for (var i = 0, len = terms.length; i < len; i++) {
                            if (terms[i] === prevStx[0].term) {
                                prevTerms = terms.slice(i);
                                break;
                            }
                        }
                    }
                } else {
                    prevTerms = [];
                    prevStx = [];
                }
            }
        }

        // We need to reverse the matches for any top level repeaters because
        // they match in reverse, and thus put their results in backwards.
        _.forEach(patternEnv, function(val, key) {
            if (val.level && val.match) {
                val.match.reverse();
            }
        });

        return {
            success: success,
            patternEnv: patternEnv,
            prevStx: prevStx,
            prevTerms: prevTerms
        };
    }

    function hasMatch(m) {
        if (m.level === 0) {
            return m.match.length > 0;
        }
        return m.match.every(function(m) { return hasMatch(m); });
    }
    
    // given the given the macroBody (list of Pattern syntax objects) and the
    // environment (a mapping of patterns to syntax) return the body with the
    // appropriate patterns replaces with their value in the environment
    function transcribe(macroBody, macroNameStx, env) {

        return _.chain(macroBody)
            .reduce(function(acc, bodyStx, idx, original) {
                    // first find the ellipses and mark the syntax objects
                    // (note that this step does not eagerly go into delimiter bodies)
                    var last = original[idx-1];
                    var next = original[idx+1];
                    var nextNext = original[idx+2];

                   // drop `...`
                    if (bodyStx.token.value === "...") {
                        return acc;
                    }
                    // drop `(<separator)` when followed by an ellipse
                    if (delimIsSeparator(bodyStx) &&
                        next && next.token.value === "...") {
                        return acc;
                    }

                    // skip the $ in $(...)
                    if (bodyStx.token.value === "$" &&
                        next && next.token.type === parser.Token.Delimiter &&
                        next.token.value === "()") {

                        return acc;
                    }

                    // mark $[...] as a literal
                    if (bodyStx.token.value === "$" &&
                        next && next.token.type === parser.Token.Delimiter &&
                        next.token.value === "[]") {

                        next.literal = true;
                        return acc;
                    }

                    if (bodyStx.token.type === parser.Token.Delimiter &&
                        bodyStx.token.value === "()" &&
                        last && last.token.value === "$") {

                        bodyStx.group = true;
                    }

                    // literal [] delimiters have their bodies just
                    // directly passed along
                    if (bodyStx.literal === true) {
                        assert(bodyStx.token.type === parser.Token.Delimiter,
                                        "expecting a literal to be surrounded by []");
                        return acc.concat(bodyStx.token.inner);
                    }

                    if (next && next.token.value === "...") {
                        bodyStx.repeat = true;
                        bodyStx.separator = " "; // default to space separated
                    } else if (delimIsSeparator(next) &&
                               nextNext && nextNext.token.value === "...") {
                        bodyStx.repeat = true;
                        bodyStx.separator = next.token.inner[0].token.value;
                    }

                    acc.push(bodyStx);
                    return acc;
                }, []).reduce(function(acc, bodyStx, idx) {
                // then do the actual transcription
                if (bodyStx.repeat) {
                    if (bodyStx.token.type === parser.Token.Delimiter) {
                        bodyStx.expose();

                        var fv = _.filter(freeVarsInPattern(bodyStx.token.inner),
                                          function(pat) {
                                              // ignore "patterns"
                                              // that aren't in the
                                              // environment (treat
                                              // them like literals)
                                              return env.hasOwnProperty(pat);
                                          });
                        var restrictedEnv = [];
                        var nonScalar = _.find(fv, function(pat) {
                            return env[pat].level > 0;
                        });

                        assert(typeof nonScalar !== 'undefined',
                                      "must have a least one non-scalar in repeat");

                        var repeatLength = env[nonScalar].match.length;
                        var sameLength = _.all(fv, function(pat) {
                            return (env[pat].level === 0) ||
                                (env[pat].match.length === repeatLength);
                        });
                        assert(sameLength,
                                      "all non-scalars must have the same length");

                        // create a list of envs restricted to the free vars
                        _.each(_.range(repeatLength), function(idx) {
                            var renv = {};
                            _.each(fv, function(pat) {
                                if (env[pat].level === 0) {
                                    // copy scalars over
                                    renv[pat] = env[pat];
                                } else {
                                    // grab the match at this index 
                                    renv[pat] = env[pat].match[idx];
                                }
                            });
                            var allHaveMatch = Object.keys(renv).every(function(pat) {
                                return hasMatch(renv[pat]);
                            });
                            if (allHaveMatch) {
                                restrictedEnv.push(renv); 
                            }
                        });

                        var transcribed = _.map(restrictedEnv, function(renv) {
                            if (bodyStx.group) {
                                return transcribe(bodyStx.token.inner,
                                                  macroNameStx,
                                                  renv);
                            } else {
                                var newBody = syntaxFromToken(_.clone(bodyStx.token),
                                                              bodyStx);
                                newBody.token.inner = transcribe(bodyStx.token.inner,
                                                                 macroNameStx,
                                                                 renv);
                                return newBody;
                            }
                        });
                        var joined;
                        if (bodyStx.group) {
                            joined = joinSyntaxArr(transcribed, bodyStx.separator);
                        } else {
                            joined = joinSyntax(transcribed, bodyStx.separator);
                        }
                        push.apply(acc, joined);
                        return acc;
                    }

                    if (!env[bodyStx.token.value]) {
                        throwSyntaxError("patterns", "The pattern variable is not bound for the template", bodyStx);
                    } else if (env[bodyStx.token.value].level !== 1) {
                        throwSyntaxError("patterns", "Ellipses level does not match in the template", bodyStx);
                    } 
                    push.apply(acc, joinRepeatedMatch(env[bodyStx.token.value].match,
                                                      bodyStx.separator))
                    return acc;
                } else {
                    if (bodyStx.token.type === parser.Token.Delimiter) {
                        bodyStx.expose();
                        var newBody = syntaxFromToken(_.clone(bodyStx.token),
                                                      macroBody);
                        newBody.token.inner = transcribe(bodyStx.token.inner,
                                                         macroNameStx, env);
                        acc.push(newBody);
                        return acc;
                    }
                    if (isPatternVar(bodyStx) &&
                        Object.prototype.hasOwnProperty.bind(env)(bodyStx.token.value)) {
                        if (!env[bodyStx.token.value]) {
                            throwSyntaxError("patterns", "The pattern variable is not bound for the template", bodyStx);
                        } else if (env[bodyStx.token.value].level !== 0) {
                            throwSyntaxError("patterns", "Ellipses level does not match in the template", bodyStx);
                        } 
                        push.apply(acc, takeLineContext(bodyStx, env[bodyStx.token.value].match));
                        return acc;
                    }
                    acc.push(bodyStx);
                    return acc;
                }
            }, []).value();
    }

    exports.loadPattern = loadPattern;
    exports.matchPatterns = matchPatterns;
    exports.matchLookbehind = matchLookbehind;
    exports.transcribe = transcribe;
    exports.matchPatternClass = matchPatternClass;
    exports.takeLineContext = takeLineContext;
    exports.takeLine = takeLine;
    exports.typeIsLiteral = typeIsLiteral;
}))
