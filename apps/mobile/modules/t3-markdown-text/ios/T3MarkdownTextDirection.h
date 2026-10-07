#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

// Hebrew through Arabic Extended-A, the Hebrew and Arabic presentation forms, and the
// supplementary-plane right-to-left scripts. Kept in step with `src/textDirection.ts`.
static inline BOOL T3MarkdownTextIsRightToLeftCharacter(UTF32Char character)
{
  return (character >= 0x0590 && character <= 0x08FF) ||
      (character >= 0xFB1D && character <= 0xFDFF) ||
      (character >= 0xFE70 && character <= 0xFEFF) ||
      (character >= 0x10800 && character <= 0x10FFF) ||
      (character >= 0x1E800 && character <= 0x1EFFF);
}

/// The direction of the first letter in `range`, the way HTML's `dir="auto"` picks it, or
/// natural when the range has no letters.
static inline NSWritingDirection T3MarkdownTextContentDirection(NSString *string, NSRange range)
{
  NSCharacterSet *letters = NSCharacterSet.letterCharacterSet;
  const NSUInteger end = NSMaxRange(range);
  for (NSUInteger index = range.location; index < end; index++) {
    UTF32Char character = [string characterAtIndex:index];
    if (CFStringIsSurrogateHighCharacter(character) && index + 1 < end) {
      const unichar low = [string characterAtIndex:index + 1];
      if (CFStringIsSurrogateLowCharacter(low)) {
        character = CFStringGetLongCharacterForSurrogatePair((unichar)character, low);
        index++;
      }
    }
    if ([letters longCharacterIsMember:character]) {
      return T3MarkdownTextIsRightToLeftCharacter(character) ? NSWritingDirectionRightToLeft
                                                             : NSWritingDirectionLeftToRight;
    }
  }
  return NSWritingDirectionNatural;
}

/// Lays out each paragraph in its own script's direction. TextKit's natural alignment
/// follows the app's language rather than the text, so without this an Arabic paragraph
/// sits on the left in an English app. Paragraphs with an explicit left alignment, such as
/// code, stay left to right whatever they contain.
static inline void T3MarkdownTextApplyContentDirection(NSMutableAttributedString *attributedString)
{
  NSString *string = attributedString.string;
  // Natural alignment already reads left to right in a left-to-right app, so left-to-right
  // prose keeps its style untouched there.
  const BOOL naturalIsLeftToRight =
      [NSParagraphStyle defaultWritingDirectionForLanguage:nil] == NSWritingDirectionLeftToRight;
  [string enumerateSubstringsInRange:NSMakeRange(0, string.length)
                             options:NSStringEnumerationByParagraphs |
                                     NSStringEnumerationSubstringNotRequired
                          usingBlock:^(NSString *substring, NSRange paragraphRange, NSRange enclosingRange, BOOL *stop) {
    if (enclosingRange.length == 0) {
      return;
    }
    const NSParagraphStyle *leadingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:enclosingRange.location
                     effectiveRange:nil];
    const NSTextAlignment alignment = leadingStyle ? leadingStyle.alignment : NSTextAlignmentNatural;
    const NSWritingDirection direction = alignment == NSTextAlignmentNatural
        ? T3MarkdownTextContentDirection(string, paragraphRange)
        : alignment == NSTextAlignmentLeft ? NSWritingDirectionLeftToRight
                                           : NSWritingDirectionNatural;
    if (direction == NSWritingDirectionNatural ||
        (direction == NSWritingDirectionLeftToRight && alignment == NSTextAlignmentNatural &&
         naturalIsLeftToRight)) {
      return;
    }

    [attributedString enumerateAttribute:NSParagraphStyleAttributeName
                                 inRange:enclosingRange
                                 options:0
                              usingBlock:^(id value, NSRange range, BOOL *stop) {
      NSParagraphStyle *existingStyle = value;
      if (existingStyle.baseWritingDirection == direction) {
        return;
      }
      NSMutableParagraphStyle *paragraphStyle =
          existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
      paragraphStyle.baseWritingDirection = direction;
      if (direction == NSWritingDirectionRightToLeft) {
        // A left tab stop in a right-to-left paragraph pins list text to the marker; a
        // natural one measures from the leading (right) edge like the indents do.
        NSMutableArray<NSTextTab *> *tabStops = [NSMutableArray array];
        for (NSTextTab *tab in paragraphStyle.tabStops) {
          [tabStops addObject:[[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentNatural
                                                              location:tab.location
                                                               options:tab.options]];
        }
        paragraphStyle.tabStops = tabStops;
      }
      [attributedString addAttribute:NSParagraphStyleAttributeName
                               value:paragraphStyle
                               range:range];
    }];
  }];
}
