dnl This Source Code Form is subject to the terms of the Mozilla Public
dnl License, v. 2.0. If a copy of the MPL was not distributed with this
dnl file, You can obtain one at http://mozilla.org/MPL/2.0/.

AC_DEFUN([MOZ_ROKU_NDK],
[

MOZ_ARG_WITH_STRING(roku-ndk,
[  --with-roku-ndk=DIR
                          location where the Roku NDK can be found],
    roku_ndk=$withval)

case "$target" in
*-brcm-linux*)
    if test -z "$roku_ndk" ; then
        AC_MSG_ERROR([You must specify --with-roku-ndk=/path/to/ndk when targeting Roku.])
    fi

    roku_platform="$roku_ndk/platforms/Roku2"
    roku_toolchain="$roku_platform/toolchain"
    roku_toolprefix="arm-linux"

    if test -d "$roku_platform" ; then
        AC_MSG_RESULT([$roku_platform])
    else
        AC_MSG_ERROR([not found. Please check your NDK. With the current configuration, it should be in $roku_platform])
    fi

    if test -d "$roku_toolchain" ; then
        AC_MSG_RESULT([$roku_toolchain])
    else
        AC_MSG_ERROR([not found. Please check your NDK. With the current configuration, it should be in $roku_toolchain])
    fi

    dnl set up compilers
    AS="$roku_toolchain"/bin/"$roku_toolprefix"-as
    if test -z "$CC"; then
        CC="$roku_toolchain"/bin/"$roku_toolprefix"-gcc
    fi
    if test -z "$CXX"; then
        CXX="$roku_toolchain"/bin/"$roku_toolprefix"-g++
    fi
    dnl Roku doesn't include cpp in the NDK, so use the native platform one?
    if test -z "$CPP"; then
        CPP="$roku_toolchain"/bin/"$roku_toolprefix"-cpp
    fi
    LD="$roku_toolchain"/bin/"$roku_toolprefix"-ld
    AR="$roku_toolchain"/bin/"$roku_toolprefix"-ar
    RANLIB="$roku_toolchain"/bin/"$roku_toolprefix"-ranlib
    STRIP="$roku_toolchain"/bin/"$roku_toolprefix"-strip
    OBJCOPY="$roku_toolchain"/bin/"$roku_toolprefix"-objcopy

    CPPFLAGS="-DBUILD_PLATFORM_ROKU2 -DROKU -DLINUX -idirafter $roku_platform/include -idirafter $roku_platform/usr/include $CPPFLAGS"
    CFLAGS="-mcpu=arm1176jzf-s -Wno-psabi -Wno-uninitialized -Wno-type-limits -U_FORTIFY_SOURCE -fno-short-enums -fno-exceptions $CFLAGS"
    CXXFLAGS="-fvisibility-inlines-hidden -mcpu=arm1176jzf-s -Wno-psabi -Wno-uninitialized -Wno-type-limits -U_FORTIFY_SOURCE -fno-short-enums -fno-exceptions $CXXFLAGS"
    ASFLAGS="$ASFLAGS"
    STRIPFLAGS="--remove-section=.comment --remove-section=.note --strip-unneeded"

    LDFLAGS="-Wl,-rpath,/pkg:/lib -Wl,--disable-new-dtags -Wl,--gc-sections -Wl,--copy-dt-needed-entries -Wl,--allow-shlib-undefined -L$roku_platform/lib  -L$roku_platform/usr/lib -L$roku_toolchain/arm-brcm-linux-gnueabi/sys-root/usr/lib -L$HOME/usr/lib $LDFLAGS -lrt"

    dnl Roku specific flags
    MOZ_TREE_FREETYPE=1
    ZLIB_DIR=yes

    dnl prevent cross compile section from using these flags as host flags
    if test -z "$HOST_CPPFLAGS" ; then
        HOST_CPPFLAGS=" "
    fi
    if test -z "$HOST_CFLAGS" ; then
        HOST_CFLAGS=" "
    fi
    if test -z "$HOST_CXXFLAGS" ; then
        HOST_CXXFLAGS=" "
    fi
    if test -z "$HOST_LDFLAGS" ; then
        HOST_LDFLAGS=" "
    fi

    ROKU_NDK="${roku_ndk}"
    ROKU_TOOLCHAIN="${roku_toolchain}"
    ROKU_PLATFORM="${roku_platform}"

    AC_DEFINE(ROKU)
    AC_SUBST(ROKU_NDK)
    AC_SUBST(ROKU_TOOLCHAIN)
    AC_SUBST(ROKU_PLATFORM)

    ;;
esac

])

