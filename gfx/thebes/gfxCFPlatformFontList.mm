/* -*- Mode: ObjC; tab-width: 20; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * ***** BEGIN LICENSE BLOCK *****
 * Version: BSD
 *
 * Copyright (C) 2006-2009 Mozilla Corporation.  All rights reserved.
 *
 * Contributor(s):
 *   Vladimir Vukicevic <vladimir@pobox.com>
 *   Masayuki Nakano <masayuki@d-toybox.com>
 *   John Daggett <jdaggett@mozilla.com>
 *   Jonathan Kew <jfkthame@gmail.com>
 *
 * Copyright (C) 2006 Apple Computer, Inc.  All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * ***** END LICENSE BLOCK ***** */

#include "mozilla/Logging.h"

#include <algorithm>

#import <UIKit/UIKit.h>

#include "gfxPlatformMac.h"
#include "gfxCFPlatformFontList.h"
#include "gfxMacFont.h"
#include "gfxUserFontSet.h"
#include "harfbuzz/hb.h"

#include "nsServiceManagerUtils.h"
#include "nsTArray.h"

#include "nsDirectoryServiceUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsISimpleEnumerator.h"
#include "nsCharTraits.h"
#include "gfxFontConstants.h"

#include "mozilla/MemoryReporting.h"
#include "mozilla/Preferences.h"
#include "mozilla/Telemetry.h"
#include "mozilla/gfx/2D.h"

#include <unistd.h>
#include <time.h>
#include <dlfcn.h>

using namespace mozilla;

// CTFontCollectionCopyOptions has been removed from the iOS SDK.
enum myCTFontCollectionCopyOptions {
    kMyCTFontCollectionCopyDefaultOptions = 0,
    kMyCTFontCollectionCopyUnique = (1L << 0),
    kMyCTFontCollectionCopyStandardSort = (1L << 1)
};

#define CTFontCollectionCopyOptions myCTFontCollectionCopyOptions
#define kCTFontCollectionCopyUnique kMyCTFontCollectionCopyUnique

static void GetStringForCFString(CFStringRef aSrc, nsAString& aDest)
{
    auto len = CFStringGetLength(aSrc);
    aDest.SetLength(len);
    CFStringGetCharacters(aSrc, CFRangeMake(0, len),
                          (UniChar*)aDest.BeginWriting());
}

static CFStringRef CreateCFStringForString(const nsAString& aSrc)
{
    return CFStringCreateWithCharacters(kCFAllocatorDefault,
                                        (const UniChar*)aSrc.BeginReading(),
                                        aSrc.Length());
}

#define LOG_FONTLIST(args) MOZ_LOG(gfxPlatform::GetLog(eGfxLog_fontlist), \
                               mozilla::LogLevel::Debug, args)
#define LOG_FONTLIST_ENABLED() MOZ_LOG_TEST( \
                                   gfxPlatform::GetLog(eGfxLog_fontlist), \
                                   mozilla::LogLevel::Debug)
#define LOG_CMAPDATA_ENABLED() MOZ_LOG_TEST( \
                                   gfxPlatform::GetLog(eGfxLog_cmapdata), \
                                   mozilla::LogLevel::Debug)

#pragma mark-

// Complex scripts will not render correctly unless appropriate AAT or OT
// layout tables are present.
// For OpenType, we also check that the GSUB table supports the relevant
// script tag, to avoid using things like Arial Unicode MS for Lao (it has
// the characters, but lacks OpenType support).

// TODO: consider whether we should move this to gfxFontEntry and do similar
// cmap-masking on other platforms to avoid using fonts that won't shape
// properly.

nsresult
MacOSFontEntry::ReadCMAP(FontInfoData *aFontInfoData)
{
    // attempt this once, if errors occur leave a blank cmap
    if (mCharacterMap) {
        return NS_OK;
    }

    RefPtr<gfxCharacterMap> charmap;
    nsresult rv;
    bool symbolFont = false; // currently ignored

    if (aFontInfoData && (charmap = GetCMAPFromFontInfo(aFontInfoData,
                                                        mUVSOffset,
                                                        symbolFont))) {
        rv = NS_OK;
    } else {
        uint32_t kCMAP = TRUETYPE_TAG('c','m','a','p');
        charmap = new gfxCharacterMap();
        AutoTable cmapTable(this, kCMAP);

        if (cmapTable) {
            bool unicodeFont = false; // currently ignored
            uint32_t cmapLen;
            const uint8_t* cmapData =
                reinterpret_cast<const uint8_t*>(hb_blob_get_data(cmapTable,
                                                                  &cmapLen));
            rv = gfxFontUtils::ReadCMAP(cmapData, cmapLen,
                                        *charmap, mUVSOffset,
                                        unicodeFont, symbolFont);
        } else {
            rv = NS_ERROR_NOT_AVAILABLE;
        }
    }

    if (NS_SUCCEEDED(rv) && !HasGraphiteTables()) {
        // We assume a Graphite font knows what it's doing,
        // and provides whatever shaping is needed for the
        // characters it supports, so only check/clear the
        // complex-script ranges for non-Graphite fonts

        // for layout support, check for the presence of mort/morx and/or
        // opentype layout tables
        bool hasAATLayout = HasFontTable(TRUETYPE_TAG('m','o','r','x')) ||
                            HasFontTable(TRUETYPE_TAG('m','o','r','t'));
        bool hasGSUB = HasFontTable(TRUETYPE_TAG('G','S','U','B'));
        bool hasGPOS = HasFontTable(TRUETYPE_TAG('G','P','O','S'));
        if (hasAATLayout && !(hasGSUB || hasGPOS)) {
            mRequiresAAT = true; // prefer CoreText if font has no OTL tables
        }

        for (const ScriptRange* sr = gfxPlatformFontList::sComplexScriptRanges;
             sr->rangeStart; sr++) {
            // check to see if the cmap includes complex script codepoints
            if (charmap->TestRange(sr->rangeStart, sr->rangeEnd)) {
                if (hasAATLayout) {
                    // prefer CoreText for Apple's complex-script fonts,
                    // even if they also have some OpenType tables
                    // (e.g. Geeza Pro Bold on 10.6; see bug 614903)
                    mRequiresAAT = true;
                    // and don't mask off complex-script ranges, we assume
                    // the AAT tables will provide the necessary shaping
                    continue;
                }

                // We check for GSUB here, as GPOS alone would not be ok.
                if (hasGSUB && SupportsScriptInGSUB(sr->tags)) {
                    continue;
                }

                charmap->ClearRange(sr->rangeStart, sr->rangeEnd);
            }
        }
    }

    mHasCmapTable = NS_SUCCEEDED(rv);
    if (mHasCmapTable) {
        gfxPlatformFontList *pfl = gfxPlatformFontList::PlatformFontList();
        mCharacterMap = pfl->FindCharMap(charmap);
    } else {
        // if error occurred, initialize to null cmap
        mCharacterMap = new gfxCharacterMap();
    }

    LOG_FONTLIST(("(fontlist-cmap) name: %s, size: %d hash: %8.8x%s\n",
                  NS_ConvertUTF16toUTF8(mName).get(),
                  charmap->SizeOfIncludingThis(moz_malloc_size_of),
                  charmap->mHash, mCharacterMap == charmap ? " new" : ""));
    if (LOG_CMAPDATA_ENABLED()) {
        char prefix[256];
        sprintf(prefix, "(cmapdata) name: %.220s",
                NS_ConvertUTF16toUTF8(mName).get());
        charmap->Dump(prefix, eGfxLog_cmapdata);
    }

    return rv;
}

gfxFont*
MacOSFontEntry::CreateFontInstance(const gfxFontStyle *aFontStyle, bool aNeedsBold)
{
    return new gfxMacFont(this, aFontStyle, aNeedsBold);
}

bool
MacOSFontEntry::IsCFF()
{
    if (!mIsCFFInitialized) {
        mIsCFFInitialized = true;
        mIsCFF = HasFontTable(TRUETYPE_TAG('C','F','F',' '));
    }

    return mIsCFF;
}

MacOSFontEntry::MacOSFontEntry(const nsAString& aPostscriptName,
                               int32_t aWeight,
                               bool aIsStandardFace)
    : gfxFontEntry(aPostscriptName, aIsStandardFace),
      mFontRef(NULL),
      mFontRefInitialized(false),
      mRequiresAAT(false),
      mIsCFF(false),
      mIsCFFInitialized(false)
{
    mWeight = aWeight;
}

MacOSFontEntry::MacOSFontEntry(const nsAString& aPostscriptName,
                               CGFontRef aFontRef,
                               uint16_t aWeight, uint16_t aStretch,
                               uint32_t aItalicStyle,
                               bool aIsDataUserFont,
                               bool aIsLocalUserFont)
    : gfxFontEntry(aPostscriptName, false),
      mFontRef(NULL),
      mFontRefInitialized(false),
      mRequiresAAT(false),
      mIsCFF(false),
      mIsCFFInitialized(false)
{
    mFontRef = aFontRef;
    mFontRefInitialized = true;
    ::CFRetain(mFontRef);

    mWeight = aWeight;
    mStretch = aStretch;
    mFixedPitch = false; // xxx - do we need this for downloaded fonts?
    mStyle = aItalicStyle;

    NS_ASSERTION(!(aIsDataUserFont && aIsLocalUserFont),
                 "userfont is either a data font or a local font");
    mIsDataUserFont = aIsDataUserFont;
    mIsLocalUserFont = aIsLocalUserFont;
}

CGFontRef
MacOSFontEntry::GetFontRef()
{
    if (!mFontRefInitialized) {
        mFontRefInitialized = true;
        CFStringRef psname = CreateCFStringForString(mName);
        mFontRef = CGFontCreateWithFontName(psname);
        CFRelease(psname);
    }
    return mFontRef;
}

// For a logging build, we wrap the CFDataRef in a FontTableRec so that we can
// use the MOZ_COUNT_[CD]TOR macros in it. A release build without logging
// does not get this overhead.
class FontTableRec {
public:
    explicit FontTableRec(CFDataRef aDataRef)
        : mDataRef(aDataRef)
    {
        MOZ_COUNT_CTOR(FontTableRec);
    }

    ~FontTableRec() {
        MOZ_COUNT_DTOR(FontTableRec);
        ::CFRelease(mDataRef);
    }

private:
    CFDataRef mDataRef;
};

/*static*/ void
MacOSFontEntry::DestroyBlobFunc(void* aUserData)
{
#ifdef NS_BUILD_REFCNT_LOGGING
    FontTableRec *ftr = static_cast<FontTableRec*>(aUserData);
    delete ftr;
#else
    ::CFRelease((CFDataRef)aUserData);
#endif
}

hb_blob_t *
MacOSFontEntry::GetFontTable(uint32_t aTag)
{
    CGFontRef fontRef = GetFontRef();
    if (!fontRef) {
        return nullptr;
    }

    CFDataRef dataRef = ::CGFontCopyTableForTag(fontRef, aTag);
    if (dataRef) {
        return hb_blob_create((const char*)::CFDataGetBytePtr(dataRef),
                              ::CFDataGetLength(dataRef),
                              HB_MEMORY_MODE_READONLY,
#ifdef NS_BUILD_REFCNT_LOGGING
                              new FontTableRec(dataRef),
#else
                              (void*)dataRef,
#endif
                              DestroyBlobFunc);
    }

    return nullptr;
}

bool
MacOSFontEntry::HasFontTable(uint32_t aTableTag)
{
    if (mAvailableTables.Count() == 0) {
        CGFontRef fontRef = GetFontRef();
        if (!fontRef) {
            return false;
        }
        CFArrayRef tags = ::CGFontCopyTableTags(fontRef);
        if (!tags) {
            return false;
        }
        int numTags = (int) ::CFArrayGetCount(tags);
        for (int t = 0; t < numTags; t++) {
            uint32_t tag = (uint32_t)(uintptr_t)::CFArrayGetValueAtIndex(tags, t);
            mAvailableTables.PutEntry(tag);
        }
        ::CFRelease(tags);
    }

    return mAvailableTables.GetEntry(aTableTag);
}

void
MacOSFontEntry::AddSizeOfIncludingThis(MallocSizeOf aMallocSizeOf,
                                       FontListSizes* aSizes) const
{
    aSizes->mFontListSize += aMallocSizeOf(this);
    AddSizeOfExcludingThis(aMallocSizeOf, aSizes);
}

/* gfxMacFontFamily */
#pragma mark-

class gfxMacFontFamily : public gfxFontFamily
{
public:
    explicit gfxMacFontFamily(nsAString& aName) :
        gfxFontFamily(aName)
    {}

    virtual ~gfxMacFontFamily() {}

    virtual void LocalizedName(nsAString& aLocalizedName);

    virtual void FindStyleVariations(FontInfoData *aFontInfoData = nullptr);

    void AddFace(CTFontDescriptorRef aFace);
    CTFontDescriptorRef CreateDescriptor(bool aNormalized);
};

void
gfxMacFontFamily::LocalizedName(nsAString& aLocalizedName)
{
    if (!HasOtherFamilyNames()) {
        aLocalizedName = mName;
        return;
    }

    CTFontDescriptorRef descriptor = CreateDescriptor(true);

    CFStringRef language;
    CFStringRef localized = (CFStringRef)
        CTFontDescriptorCopyLocalizedAttribute(descriptor,
                                               kCTFontFamilyNameAttribute,
                                               &language);
    CFRelease(descriptor);

    if (localized) {
        GetStringForCFString(localized, aLocalizedName);
        CFRelease(localized);
        return;
    }

    // failed to get localized name, just use the canonical one
    aLocalizedName = mName;
}

// Return the CSS weight value to use for the given face, overriding what
// AppKit gives us (used to adjust families with bad weight values, see
// bug 931426).
// A return value of 0 indicates no override - use the existing weight.
static inline int
GetWeightOverride(const nsAString& aPSName)
{
    nsAutoCString prefName("font.weight-override.");
    // The PostScript name is required to be ASCII; if it's not, the font is
    // broken anyway, so we really don't care that this is lossy.
    LossyAppendUTF16toASCII(aPSName, prefName);
    return Preferences::GetInt(prefName.get(), 0);
}

CTFontDescriptorRef
gfxMacFontFamily::CreateDescriptor(bool aNormalized)
{
    CFStringRef family = CreateCFStringForString(mName);
    const void* values[] = { family };
    const void* keys[] = { kCTFontFamilyNameAttribute };
    CFDictionaryRef attributes =
        CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
                           &kCFTypeDictionaryKeyCallBacks,
                           &kCFTypeDictionaryValueCallBacks);
    CFRelease(family);

    CTFontDescriptorRef descriptor =
        CTFontDescriptorCreateWithAttributes(attributes);
    CFRelease(attributes);

    if (aNormalized) {
        CTFontDescriptorRef normalized =
            CTFontDescriptorCreateMatchingFontDescriptor(descriptor, nullptr);
        if (normalized) {
            CFRelease(descriptor);
            return normalized;
        }
    }

    return descriptor;
}

static void
AddFaceFunc(const void* aValue, void* aContext)
{
    gfxMacFontFamily* family = (gfxMacFontFamily*)aContext;
    family->AddFace((CTFontDescriptorRef)aValue);
}

void
gfxMacFontFamily::FindStyleVariations(FontInfoData *aFontInfoData)
{
    if (mHasStyles) {
        return;
    }

    CTFontDescriptorRef descriptor = CreateDescriptor(false);
    CFArrayRef faces =
        CTFontDescriptorCreateMatchingFontDescriptors(descriptor, nullptr);
    CFRelease(descriptor);

    if (faces) {
        CFArrayApplyFunction(faces, CFRangeMake(0, CFArrayGetCount(faces)),
                             AddFaceFunc, this);
        CFRelease(faces);
    }

    SortAvailableFonts();
    SetHasStyles(true);

    if (mIsBadUnderlineFamily) {
        SetBadUnderlineFonts();
    }
}

void
gfxMacFontFamily::AddFace(CTFontDescriptorRef aFace)
{
    CFStringRef psname =
        (CFStringRef)CTFontDescriptorCopyAttribute(aFace, kCTFontNameAttribute);
    CFStringRef facename =
        (CFStringRef)CTFontDescriptorCopyAttribute(aFace, kCTFontStyleNameAttribute);

    CFDictionaryRef traitsDict =
        (CFDictionaryRef)CTFontDescriptorCopyAttribute(aFace, kCTFontTraitsAttribute);
    CFNumberRef weight =
        (CFNumberRef)CFDictionaryGetValue(traitsDict, kCTFontWeightTrait);
    CFNumberRef width =
        (CFNumberRef)CFDictionaryGetValue(traitsDict, kCTFontWidthTrait);
    CFNumberRef symbolicTraits =
        (CFNumberRef)CFDictionaryGetValue(traitsDict, kCTFontSymbolicTrait);

    bool isStandardFace = false;

    // make a nsString
    nsAutoString postscriptFontName;
    GetStringForCFString(psname, postscriptFontName);

    int32_t cssWeight = GetWeightOverride(postscriptFontName);
    CGFloat weightValue;
    CFNumberGetValue(weight, kCFNumberCGFloatType, &weightValue);
    if (cssWeight) {
        // scale down and clamp, to get a value from 1..9
        cssWeight = ((cssWeight + 50) / 100);
        cssWeight = std::max(1, std::min(cssWeight, 9));
    } else {
        cssWeight =
            gfxMacPlatformFontList::CoreTextWeightToCSSWeight(weightValue);
    }
    cssWeight *= 100; // scale up to CSS values

    if (kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Regular"), 0) ||
        kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Bold"), 0) ||
        kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Italic"), 0) ||
        kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Oblique"), 0) ||
        kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Bold Italic"), 0) ||
        kCFCompareEqualTo == CFStringCompare(facename, CFSTR("Bold Oblique"), 0))
    {
        isStandardFace = true;
    }

    // create a font entry
    MacOSFontEntry *fontEntry =
        new MacOSFontEntry(postscriptFontName, cssWeight, isStandardFace);

    CGFloat widthValue;
    CFNumberGetValue(width, kCFNumberCGFloatType, &widthValue);
    // set additional properties based on the traits reported by Cocoa
    if (widthValue < 0.0) {
        fontEntry->mStretch = NS_FONT_STRETCH_CONDENSED;
    } else if (widthValue > 0.0) {
        fontEntry->mStretch = NS_FONT_STRETCH_EXPANDED;
    }

    SInt32 traitsValue;
    CFNumberGetValue(symbolicTraits, kCFNumberSInt32Type, &traitsValue);
    if (traitsValue & kCTFontItalicTrait) {
        fontEntry->mStyle = NS_FONT_STYLE_ITALIC;
    }

    if (traitsValue & kCTFontMonoSpaceTrait) {
        fontEntry->mFixedPitch = true;
    }

    if (LOG_FONTLIST_ENABLED()) {
        LOG_FONTLIST(("(fontlist) added (%s) to family (%s)"
             " with style: %s weight: %d stretch: %d"
             " (weight: %f width: %f)",
             NS_ConvertUTF16toUTF8(fontEntry->Name()).get(),
             NS_ConvertUTF16toUTF8(Name()).get(),
             fontEntry->IsItalic() ? "italic" : "normal",
             cssWeight, fontEntry->Stretch(),
             weightValue, widthValue));
    }

    // insert into font entry array of family
    AddFontEntry(fontEntry);

    CFRelease(psname);
    CFRelease(facename);
    CFRelease(traitsDict);
}

/* gfxSingleFaceMacFontFamily */
#pragma mark-

class gfxSingleFaceMacFontFamily : public gfxMacFontFamily
{
public:
    explicit gfxSingleFaceMacFontFamily(nsAString& aName) :
        gfxMacFontFamily(aName)
    {
        mFaceNamesInitialized = true; // omit from face name lists
    }

    virtual ~gfxSingleFaceMacFontFamily() {}

    virtual void LocalizedName(nsAString& aLocalizedName);

    virtual void ReadOtherFamilyNames(gfxPlatformFontList *aPlatformFontList);
};

void
gfxSingleFaceMacFontFamily::LocalizedName(nsAString& aLocalizedName)
{
    if (!HasOtherFamilyNames()) {
        aLocalizedName = mName;
        return;
    }

    CTFontDescriptorRef descriptor = CreateDescriptor(true);

    CFStringRef language;
    CFStringRef localized = (CFStringRef)
        CTFontDescriptorCopyLocalizedAttribute(descriptor,
                                               kCTFontDisplayNameAttribute,
                                               &language);
    CFRelease(descriptor);

    if (localized) {
        GetStringForCFString(localized, aLocalizedName);
        CFRelease(localized);
        return;
    }

    // failed to get localized name, just use the canonical one
    aLocalizedName = mName;
}

void
gfxSingleFaceMacFontFamily::ReadOtherFamilyNames(gfxPlatformFontList *aPlatformFontList)
{
    if (mOtherFamilyNamesInitialized) {
        return;
    }

    gfxFontEntry *fe = mAvailableFonts[0];
    if (!fe) {
        return;
    }

    const uint32_t kNAME = TRUETYPE_TAG('n','a','m','e');

    gfxFontEntry::AutoTable nameTable(fe, kNAME);
    if (!nameTable) {
        return;
    }

    mHasOtherFamilyNames = ReadOtherFamilyNamesForFace(aPlatformFontList,
                                                       nameTable,
                                                       true);

    mOtherFamilyNamesInitialized = true;
}


/* gfxMacPlatformFontList */
#pragma mark-

gfxMacPlatformFontList::gfxMacPlatformFontList() :
    gfxPlatformFontList(false),
    mDefaultFont(nullptr)
{
#ifdef MOZ_BUNDLED_FONTS
    ActivateBundledFonts();
#endif

    ::CFNotificationCenterAddObserver(::CFNotificationCenterGetLocalCenter(),
                                      this,
                                      RegisteredFontsChangedNotificationCallback,
                                      kCTFontManagerRegisteredFontsChangedNotification,
                                      0,
                                      CFNotificationSuspensionBehaviorDeliverImmediately);
}

gfxMacPlatformFontList::~gfxMacPlatformFontList()
{
    if (mDefaultFont) {
        ::CFRelease(mDefaultFont);
    }
}

void
gfxMacPlatformFontList::AddFamilyFunc(const void *aValue, void *aContext)
{
    gfxMacPlatformFontList* fontList = (gfxMacPlatformFontList*)aContext;
    fontList->AddFamily((CFStringRef)aValue);
}

void
gfxMacPlatformFontList::AddFamily(CFStringRef aFamilyName)
{
    nsAutoString familyName;
    GetStringForCFString(aFamilyName, familyName);

    // create a family entry
    gfxFontFamily* family = new gfxMacFontFamily(familyName);

    // add the family entry to the hash table
    nsAutoString lcFamily(familyName);
    ToLowerCase(lcFamily);
    mFontFamilies.Put(lcFamily, family);
    LOG_FONTLIST(("(fontlist-family) family: %s\n",
                 NS_ConvertUTF16toUTF8(familyName).get()));

    // check the bad underline blacklist
    if (mBadUnderlineFamilyNames.Contains(lcFamily)) {
        family->SetBadUnderlineFamily();
    }
}

static void
CopyFamilyNameFunc(const void* aValue, void* aContext)
{
    // Copy: gives us an owning reference to the family name.
    CFTypeRef family =
        CTFontDescriptorCopyAttribute((CTFontDescriptorRef)aValue,
                                      kCTFontFamilyNameAttribute);
    if (family) {
        // Value is retained by the set.
        CFSetAddValue((CFMutableSetRef)aContext, family);
        // Release our reference: set now owns the sole reference to the name.
        CFRelease(family);
    }
}

CFArrayRef
myCTFontCollectionCopyFontAttribute(CTFontCollectionRef aCollection,
                                    CFStringRef aAttribute,
                                    CTFontCollectionCopyOptions aOptions)
{
    // For simplicity, we only support the kCTFontFamilyNameAttribute
    // and assume the kCTFontCollectionCopyUnique option, as that's what
    // we actually use.
    MOZ_ASSERT(kCFCompareEqualTo ==
               CFStringCompare(aAttribute, kCTFontFamilyNameAttribute, 0));
    MOZ_ASSERT(aOptions == kCTFontCollectionCopyUnique);

    CFArrayRef descriptors =
        CTFontCollectionCreateMatchingFontDescriptors(aCollection);

    // The set will own references to all the family names.
    CFMutableSetRef familySet =
        CFSetCreateMutable(kCFAllocatorDefault, 0, &kCFTypeSetCallBacks);
    CFArrayApplyFunction(descriptors,
                         CFRangeMake(0, CFArrayGetCount(descriptors)),
                         CopyFamilyNameFunc, familySet);
    CFRelease(descriptors);

    CFIndex count = CFSetGetCount(familySet);
    const void **values = new const void* [count];
    // "Get" here does not alter ownership: the set still holds our only
    // references to the names, so we mustn't release it yet.
    CFSetGetValues(familySet, values);

    // Create array; this will retain each of the values
    CFArrayRef families = CFArrayCreate(kCFAllocatorDefault, values, count,
                                        &kCFTypeArrayCallBacks);
    delete[] values;

    // Release the set, which will release its values, but the array still
    // retains them.
    CFRelease(familySet);

    return families;
}

nsresult
gfxMacPlatformFontList::InitFontListForPlatform()
{
    typedef CFArrayRef (*CTFontCollectionCopyFontAttributePtr)
        (CTFontCollectionRef, CFStringRef, CTFontCollectionCopyOptions);

    Telemetry::AutoTimer<Telemetry::MAC_INITFONTLIST_TOTAL> timer;

    // reset font lists
    gfxPlatformFontList::InitFontList();
    mSystemFontFamilies.Clear();

    // get a list of families from the collection of available fonts
    CTFontCollectionRef collection =
        CTFontCollectionCreateFromAvailableFonts(nullptr);

    CTFontCollectionCopyFontAttributePtr func =
        (CTFontCollectionCopyFontAttributePtr)
            dlsym(RTLD_DEFAULT, "CTFontCollectionCopyFontAttribute");
    if (!func) {
        func = &myCTFontCollectionCopyFontAttribute;
    }

    CFArrayRef families = func(collection, kCTFontFamilyNameAttribute,
                               kCTFontCollectionCopyUnique);
    CFRelease(collection);

    // put all the families into our font list
    CFArrayApplyFunction(families, CFRangeMake(0, CFArrayGetCount(families)),
                         AddFamilyFunc, this);
    CFRelease(families);

    InitSingleFaceList();

    // to avoid full search of font name tables, seed the other names table with localized names from
    // some of the prefs fonts which are accessed via their localized names.  changes in the pref fonts will only cause
    // a font lookup miss earlier. this is a simple optimization, it's not required for correctness
    PreloadNamesList();

    // start the delayed cmap loader
    GetPrefsAndStartLoader();

    return NS_OK;
}

void
gfxMacPlatformFontList::InitSingleFaceList()
{
    AutoTArray<nsString, 10> singleFaceFonts;
    gfxFontUtils::GetPrefsFontList("font.single-face-list", singleFaceFonts);

    uint32_t numFonts = singleFaceFonts.Length();
    for (uint32_t i = 0; i < numFonts; i++) {
        LOG_FONTLIST(("(fontlist-singleface) face name: %s\n",
                      NS_ConvertUTF16toUTF8(singleFaceFonts[i]).get()));
        gfxFontEntry *fontEntry = LookupLocalFont(singleFaceFonts[i],
                                                  400, 0,
                                                  NS_FONT_STYLE_NORMAL);
        if (fontEntry) {
            nsAutoString familyName, key;
            familyName = singleFaceFonts[i];
            GenerateFontListKey(familyName, key);
            LOG_FONTLIST(("(fontlist-singleface) family name: %s, key: %s\n",
                          NS_ConvertUTF16toUTF8(familyName).get(),
                          NS_ConvertUTF16toUTF8(key).get()));

            // add only if doesn't exist already
            if (!mFontFamilies.GetWeak(key)) {
                gfxFontFamily *familyEntry =
                    new gfxSingleFaceMacFontFamily(familyName);
                // LookupLocalFont sets this, need to clear
                fontEntry->mIsLocalUserFont = false;
                familyEntry->AddFontEntry(fontEntry);
                familyEntry->SetHasStyles(true);
                mFontFamilies.Put(key, familyEntry);
                LOG_FONTLIST(("(fontlist-singleface) added new family\n",
                              NS_ConvertUTF16toUTF8(familyName).get(),
                              NS_ConvertUTF16toUTF8(key).get()));
            }
        }
    }
}

bool
gfxMacPlatformFontList::GetStandardFamilyName(const nsAString& aFontName, nsAString& aFamilyName)
{
    gfxFontFamily *family = FindFamily(aFontName);
    if (family) {
        family->LocalizedName(aFamilyName);
        return true;
    }

    return false;
}

void
gfxMacPlatformFontList::RegisteredFontsChangedNotificationCallback(CFNotificationCenterRef center,
                                                                   void *observer,
                                                                   CFStringRef name,
                                                                   const void *object,
                                                                   CFDictionaryRef userInfo)
{
    if (!::CFEqual(name, kCTFontManagerRegisteredFontsChangedNotification)) {
        return;
    }

    gfxMacPlatformFontList* fl = static_cast<gfxMacPlatformFontList*>(observer);

    // xxx - should be carefully pruning the list of fonts, not rebuilding it from scratch
    fl->UpdateFontList();

    // modify a preference that will trigger reflow everywhere
    fl->ForceGlobalReflow();
}

gfxFontEntry*
gfxMacPlatformFontList::GlobalFontFallback(const uint32_t aCh,
                                           Script aRunScript,
                                           const gfxFontStyle* aMatchStyle,
                                           uint32_t& aCmapCount,
                                           gfxFontFamily** aMatchedFamily)
{
    bool useCmaps = gfxPlatform::GetPlatform()->UseCmapsDuringSystemFallback();

    if (useCmaps) {
        return gfxPlatformFontList::GlobalFontFallback(aCh,
                                                       aRunScript,
                                                       aMatchStyle,
                                                       aCmapCount,
                                                       aMatchedFamily);
    }

    CFStringRef str;
    UniChar ch[2];
    CFIndex length = 1;

    if (IS_IN_BMP(aCh)) {
        ch[0] = aCh;
        str = ::CFStringCreateWithCharactersNoCopy(kCFAllocatorDefault, ch, 1,
                                                   kCFAllocatorNull);
    } else {
        ch[0] = H_SURROGATE(aCh);
        ch[1] = L_SURROGATE(aCh);
        str = ::CFStringCreateWithCharactersNoCopy(kCFAllocatorDefault, ch, 2,
                                                   kCFAllocatorNull);
        if (!str) {
            return nullptr;
        }
        length = 2;
    }

    // use CoreText to find the fallback family

    gfxFontEntry *fontEntry = nullptr;
    CTFontRef fallback;
    bool cantUseFallbackFont = false;

    if (!mDefaultFont) {
        mDefaultFont = ::CTFontCreateWithName(CFSTR("LucidaGrande"), 12.f,
                                              NULL);
    }

    fallback = ::CTFontCreateForString(mDefaultFont, str,
                                       ::CFRangeMake(0, length));

    if (fallback) {
        CFStringRef familyNameRef = ::CTFontCopyFamilyName(fallback);
        ::CFRelease(fallback);

        if (familyNameRef &&
            ::CFStringCompare(familyNameRef, CFSTR("LastResort"),
                              kCFCompareCaseInsensitive) != kCFCompareEqualTo)
        {
            nsAutoString familyNameString;
            GetStringForCFString(familyNameRef, familyNameString);

            bool needsBold;  // ignored in the system fallback case

            gfxFontFamily *family = FindFamily(familyNameString);
            if (family) {
                fontEntry = family->FindFontForStyle(*aMatchStyle, needsBold);
                if (fontEntry) {
                    if (fontEntry->HasCharacter(aCh)) {
                        *aMatchedFamily = family;
                    } else {
                        fontEntry = nullptr;
                        cantUseFallbackFont = true;
                    }
                }
            }
        }

        if (familyNameRef) {
            ::CFRelease(familyNameRef);
        }
    }

    if (cantUseFallbackFont) {
        Telemetry::Accumulate(Telemetry::BAD_FALLBACK_FONT, cantUseFallbackFont);
    }

    ::CFRelease(str);

    return fontEntry;
}

gfxFontFamily*
gfxMacPlatformFontList::GetDefaultFontForPlatform(const gfxFontStyle* aStyle)
{
    // Create a font descriptor from an empty attributes dictionary.
    CFDictionaryRef attributes =
        CFDictionaryCreate(kCFAllocatorDefault, nullptr, nullptr, 0,
                           &kCFTypeDictionaryKeyCallBacks,
                           &kCFTypeDictionaryValueCallBacks);
    CTFontDescriptorRef fontDesc =
        CTFontDescriptorCreateWithAttributes(attributes);
    CFRelease(attributes);

    // Resolve the empty font descriptor to get the system's default font.
    CTFontDescriptorRef defaultFontDescriptor =
        CTFontDescriptorCreateMatchingFontDescriptor(fontDesc, nullptr);
    CFRelease(fontDesc);

    CFStringRef familyName =
        (CFStringRef)CTFontDescriptorCopyAttribute(defaultFontDescriptor,
                                                   kCTFontFamilyNameAttribute);

    nsAutoString familyNameString;
    GetStringForCFString(familyName, familyNameString);
    CFRelease(familyName);

    gfxMacFontFamily *family =
        static_cast<gfxMacFontFamily*>(FindFamily(familyNameString));
    if (family) {
        CFRelease(defaultFontDescriptor);
        return family;
    }

    family = new gfxMacFontFamily(familyNameString);

    // XXX We should use family->FindStyleVariations() here to populate it,
    // but that seems to fail with the "hidden" system fonts like
    // .Lucida Grande UI (CTFontDescriptorCreateMatchingFontDescriptors
    // returns null instead of an array of faces).

    // So for now, we'll need to use Cocoa or UIKit methods to get the
    // list of faces that should be included. :(

    // Do something with UIKit for iOS?
    // Temporary hack: just use a single default face.
    family->AddFace(defaultFontDescriptor);

    family->SetHasStyles(true);
    CFRelease(defaultFontDescriptor);

    nsAutoString lcFamily(familyNameString);
    ToLowerCase(lcFamily);
    mSystemFontFamilies.Put(lcFamily, family);

    LOG_FONTLIST(("(fontlist-hidden-family) family name: %s\n",
                  NS_ConvertUTF16toUTF8(familyNameString).get()));

    return family;
}

int32_t
gfxMacPlatformFontList::CoreTextWeightToCSSWeight(CGFloat aCTWeight)
{
    return std::max(1, std::min(9, int((aCTWeight + 1.0) * 4 + 0.5)));
}

gfxFontEntry*
gfxMacPlatformFontList::LookupLocalFont(const nsAString& aFontName,
                                        uint16_t aWeight,
                                        int16_t aStretch,
                                        uint8_t aStyle)
{
    CFStringRef faceName = CreateCFStringForString(aFontName);

    // lookup face based on postscript or full name
    CGFontRef fontRef = ::CGFontCreateWithFontName(faceName);
    CFRelease(faceName);

    if (!fontRef) {
        return nullptr;
    }

    NS_ASSERTION(aWeight >= 100 && aWeight <= 900,
                 "bogus font weight value!");

    MacOSFontEntry *newFontEntry;
    newFontEntry =
        new MacOSFontEntry(aFontName, fontRef,
                           aWeight, aStretch,
                           aStyle,
                           false, true);
    ::CFRelease(fontRef);

    return newFontEntry;
}

static void ReleaseData(void *info, const void *data, size_t size)
{
    free((void*)data);
}

gfxFontEntry*
gfxMacPlatformFontList::MakePlatformFont(const nsAString& aFontName,
                                         uint16_t aWeight,
                                         int16_t aStretch,
                                         uint8_t aStyle,
                                         const uint8_t* aFontData,
                                         uint32_t aLength)
{
    NS_ASSERTION(aFontData, "MakePlatformFont called with null data");

    NS_ASSERTION(aWeight >= 100 && aWeight <= 900, "bogus font weight value!");

    // create the font entry
    nsAutoString uniqueName;

    nsresult rv = gfxFontUtils::MakeUniqueUserFontName(uniqueName);
    if (NS_FAILED(rv)) {
        return nullptr;
    }

    CGDataProviderRef provider =
        ::CGDataProviderCreateWithData(nullptr, aFontData, aLength,
                                       &ReleaseData);
    CGFontRef fontRef = ::CGFontCreateWithDataProvider(provider);
    ::CGDataProviderRelease(provider);

    if (!fontRef) {
        return nullptr;
    }

    nsAutoPtr<MacOSFontEntry>
        newFontEntry(new MacOSFontEntry(uniqueName, fontRef, aWeight,
                                        aStretch,
                                        aStyle,
                                        true, false));
    ::CFRelease(fontRef);

    // if succeeded and font cmap is good, return the new font
    if (newFontEntry->mIsValid && NS_SUCCEEDED(newFontEntry->ReadCMAP())) {
        return newFontEntry.forget();
    }

    // if something is funky about this font, delete immediately

#if DEBUG
    NS_WARNING("downloaded font not loaded properly");
#endif

    return nullptr;
}

// used to load system-wide font info on off-main thread
class MacFontInfo : public FontInfoData {
public:
    MacFontInfo(bool aLoadOtherNames,
                bool aLoadFaceNames,
                bool aLoadCmaps) :
        FontInfoData(aLoadOtherNames, aLoadFaceNames, aLoadCmaps)
    {}

    virtual ~MacFontInfo() {}

    virtual void Load() {
        // bug 975460 - async font loader crashes sometimes under 10.6, disable
        if (OnLionOrLater()) {
            FontInfoData::Load();
        }
    }

    // loads font data for all members of a given family
    virtual void LoadFontFamilyData(const nsAString& aFamilyName);
};

void
MacFontInfo::LoadFontFamilyData(const nsAString& aFamilyName)
{
    // family name ==> CTFontDescriptor
    CFStringRef family = CreateCFStringForString(aFamilyName);
    const void* values[] = { family };
    const void* keys[] = { kCTFontFamilyNameAttribute };
    CFDictionaryRef attr =
        CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
                           &kCFTypeDictionaryKeyCallBacks,
                           &kCFTypeDictionaryValueCallBacks);
    CFRelease(family);

    CTFontDescriptorRef fontDesc = CTFontDescriptorCreateWithAttributes(attr);
    CFRelease(attr);

    CFArrayRef matchingFonts =
        CTFontDescriptorCreateMatchingFontDescriptors(fontDesc, nullptr);
    CFRelease(fontDesc);

    if (!matchingFonts) {
        return;
    }

    nsTArray<nsString> otherFamilyNames;
    bool hasOtherFamilyNames = true;

    // iterate over faces in the family
    unsigned numFaces = CFArrayGetCount(matchingFonts);
    for (unsigned f = 0; f < numFaces; f++) {
        mLoadStats.fonts++;

        CTFontDescriptorRef faceDesc =
            (CTFontDescriptorRef)CFArrayGetValueAtIndex(matchingFonts, f);
        if (!faceDesc) {
            continue;
        }
        CTFontRef fontRef = CTFontCreateWithFontDescriptor(faceDesc,
                                                           0.0, nullptr);
        if (!fontRef) {
            NS_WARNING("failed to create a CTFontRef");
            continue;
        }

        if (mLoadCmaps) {
            // face name
            CFStringRef faceName = (CFStringRef)
                CTFontDescriptorCopyAttribute(faceDesc, kCTFontNameAttribute);

            nsAutoString fontName;
            GetStringForCFString(faceName, fontName);
            CFRelease(faceName);

            // load the cmap data
            FontFaceData fontData;
            CFDataRef cmapTable = CTFontCopyTable(fontRef, kCTFontTableCmap,
                                                  kCTFontTableOptionNoOptions);

            if (cmapTable) {
                const uint8_t *cmapData =
                    (const uint8_t*)CFDataGetBytePtr(cmapTable);
                uint32_t cmapLen = CFDataGetLength(cmapTable);
                RefPtr<gfxCharacterMap> charmap = new gfxCharacterMap();
                uint32_t offset;
                bool unicodeFont = false; // ignored
                bool symbolFont = false;
                nsresult rv;

                rv = gfxFontUtils::ReadCMAP(cmapData, cmapLen, *charmap, offset,
                                            unicodeFont, symbolFont);
                if (NS_SUCCEEDED(rv)) {
                    fontData.mCharacterMap = charmap;
                    fontData.mUVSOffset = offset;
                    fontData.mSymbolFont = symbolFont;
                    mLoadStats.cmaps++;
                }
                CFRelease(cmapTable);
            }

            mFontFaceData.Put(fontName, fontData);
        }

        if (mLoadOtherNames && hasOtherFamilyNames) {
            CFDataRef nameTable = CTFontCopyTable(fontRef, kCTFontTableName,
                                                  kCTFontTableOptionNoOptions);

            if (nameTable) {
                const char *nameData = (const char*)CFDataGetBytePtr(nameTable);
                uint32_t nameLen = CFDataGetLength(nameTable);
                gfxFontFamily::ReadOtherFamilyNamesForFace(aFamilyName,
                                                           nameData, nameLen,
                                                           otherFamilyNames,
                                                           false);
                hasOtherFamilyNames = otherFamilyNames.Length() != 0;
                CFRelease(nameTable);
            }
        }

        CFRelease(fontRef);
    }
    CFRelease(matchingFonts);

    // if found other names, insert them in the hash table
    if (otherFamilyNames.Length() != 0) {
        mOtherFamilyNames.Put(aFamilyName, otherFamilyNames);
        mLoadStats.othernames += otherFamilyNames.Length();
    }
}

already_AddRefed<FontInfoData>
gfxMacPlatformFontList::CreateFontInfoData()
{
    bool loadCmaps = !UsesSystemFallback() ||
        gfxPlatform::GetPlatform()->UseCmapsDuringSystemFallback();

    RefPtr<MacFontInfo> fi =
        new MacFontInfo(true, NeedFullnamePostscriptNames(), loadCmaps);
    return fi.forget();
}

#ifdef MOZ_BUNDLED_FONTS

void
gfxMacPlatformFontList::ActivateBundledFonts()
{
    nsCOMPtr<nsIFile> localDir;
    nsresult rv = NS_GetSpecialDirectory(NS_GRE_DIR, getter_AddRefs(localDir));
    if (NS_FAILED(rv)) {
        return;
    }
    if (NS_FAILED(localDir->Append(NS_LITERAL_STRING("fonts")))) {
        return;
    }
    bool isDir;
    if (NS_FAILED(localDir->IsDirectory(&isDir)) || !isDir) {
        return;
    }

    nsCOMPtr<nsISimpleEnumerator> e;
    rv = localDir->GetDirectoryEntries(getter_AddRefs(e));
    if (NS_FAILED(rv)) {
        return;
    }

    bool hasMore;
    while (NS_SUCCEEDED(e->HasMoreElements(&hasMore)) && hasMore) {
        nsCOMPtr<nsISupports> entry;
        if (NS_FAILED(e->GetNext(getter_AddRefs(entry)))) {
            break;
        }
        nsCOMPtr<nsIFile> file = do_QueryInterface(entry);
        if (!file) {
            continue;
        }
        nsCString path;
        if (NS_FAILED(file->GetNativePath(path))) {
            continue;
        }
        CFURLRef fontURL =
            ::CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault,
                                                      (uint8_t*)path.get(),
                                                      path.Length(),
                                                      false);
        if (fontURL) {
            CFErrorRef error = nullptr;
            ::CTFontManagerRegisterFontsForURL(fontURL,
                                               kCTFontManagerScopeProcess,
                                               &error);
            ::CFRelease(fontURL);
        }
    }
}

#endif
