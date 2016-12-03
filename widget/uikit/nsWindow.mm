/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#import <UIKit/UIEvent.h>
#import <UIKit/UIGraphics.h>
#import <UIKit/UIInterface.h>
#import <UIKit/UIScreen.h>
#import <UIKit/UITapGestureRecognizer.h>
#import <UIKit/UITouch.h>
#import <UIKit/UIView.h>
#import <UIKit/UIViewController.h>
#import <UIKit/UIWindow.h>
#import <QuartzCore/QuartzCore.h>

#include <algorithm>

#include "nsWindow.h"
#include "nsScreenManager.h"
#include "nsAppShell.h"
#include "nsISupportsArray.h"
#include "nsISupportsPrimitives.h"

#include "WidgetUtils.h"
#include "nsWidgetsCID.h"
#include "nsGfxCIID.h"

#include "gfxQuartzSurface.h"
#include "gfxUtils.h"
#include "gfxImageSurface.h"
#include "gfxContext.h"
#include "nsRegion.h"
#include "Layers.h"
#include "nsTArray.h"
#include "TextEventDispatcher.h"

#include "mozilla/layers/APZCTreeManager.h"
#include "mozilla/layers/APZThreadUtils.h"
#include "mozilla/layers/CompositorBridgeParent.h"
#include "mozilla/layers/CompositorSession.h"
#include "mozilla/BasicEvents.h"
#include "mozilla/Preferences.h"
#include "mozilla/TextEvents.h"
#include "mozilla/TouchEvents.h"
#include "mozilla/Unused.h"

#include "GeckoProfiler.h"

#import "GeckoWebView.h"
#import "GeckoWebViewPrivate.h"

using namespace mozilla;
using namespace mozilla::dom;
using namespace mozilla::widget;
using namespace mozilla::layers;

static nsWindow* gActiveWindow = nullptr;

#if DEBUG_WINDOW
#define LOG(args...) fprintf(stderr, args); fprintf(stderr, "\n")
#else
#define LOG(arg...) ((void)0)
#endif

NS_IMPL_ISUPPORTS_INHERITED0(nsWindow, Inherited)

nsWindow::nsWindow()
  : mNativeView(nullptr)
  , mIsFullScreen(false)
  , mVisible(false)
  , mParent(nullptr)
{
}

nsWindow::~nsWindow()
{
}

bool
nsWindow::IsTopLevel()
{
  return mWindowType == eWindowType_toplevel ||
    mWindowType == eWindowType_dialog ||
    mWindowType == eWindowType_invisible;
}

//
// nsIWidget
//

nsresult
nsWindow::Create(nsIWidget* aParent,
                 nsNativeWidget aNativeParent,
                 const LayoutDeviceIntRect& aRect,
                 nsWidgetInitData* aInitData)
{

  nsWindow* parent = (nsWindow*) aParent;
  GeckoWebView* nativeParent = (GeckoWebView*)aNativeParent;

  if (parent == nullptr && nativeParent)
    parent = nativeParent.widget;
  if (parent && nativeParent == nullptr)
    nativeParent = parent->mNativeView;

  LOG("nsWindow[%p]::Create %p/%p [%d %d %d %d]", (void*)this, (void*)parent, (void*)nativeParent, aRect.x, aRect.y, aRect.width, aRect.height);

  mBounds = aRect;

  if (nativeParent && !nativeParent.widget) {
    nativeParent.widget = this;
  }

  LOG("nsWindow[%p]::Create bounds: %d %d %d %d", (void*)this,
     mBounds.x, mBounds.y, mBounds.width, mBounds.height);

  // Set defaults which can be overriden from aInitData in BaseCreate
  mWindowType = eWindowType_toplevel;
  mBorderStyle = eBorderStyle_default;

  Inherited::BaseCreate(aParent,
                        aInitData);

  NS_ASSERTION(IsTopLevel() || parent, "non top level window doesn't have a parent!");

  if (parent) {
    parent->mChildren.AppendElement(this);
    mParent = parent;
  }

  return NS_OK;
}

void
nsWindow::Destroy()
{
  MOZ_ASSERT(!mNativeView, "Native view should've been unset!");
  for (uint32_t i = 0; i < mChildren.Length(); ++i) {
    // why do we still have children?
    mChildren[i]->SetParent(nullptr);
  }

  if (mParent) {
    mParent->mChildren.RemoveElement(this);
  }

  nsBaseWidget::OnDestroy();
}

NS_IMETHODIMP
nsWindow::ConfigureChildren(const nsTArray<nsIWidget::Configuration>& config)
{
  for (uint32_t i = 0; i < config.Length(); ++i) {
    nsWindow *childWin = (nsWindow*) config[i].mChild.get();
    childWin->Resize(config[i].mBounds.x,
                     config[i].mBounds.y,
                     config[i].mBounds.width,
                     config[i].mBounds.height,
                     false);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsWindow::Move(double aX, double aY)
{
  if (mBounds.x == aX && mBounds.y == aY)
    return NS_OK;

  mBounds.x = aX;
  mBounds.y = aY;

  ReportMoveEvent();
  return NS_OK;
}

NS_IMETHODIMP
nsWindow::Resize(double aX, double aY,
         double aWidth, double aHeight,
         bool aRepaint)
{
  BOOL isMoving = (mBounds.x != aX || mBounds.y != aY);
  BOOL isResizing = (mBounds.width != aWidth || mBounds.height != aHeight);
  if (!isMoving && !isResizing)
    return NS_OK;

  if (isMoving) {
    mBounds.x = aX;
    mBounds.y = aY;
  }

  if (isResizing) {
    mBounds.width  = aWidth;
    mBounds.height  = aHeight;
  }

  if (isMoving)
    ReportMoveEvent();

  if (isResizing) {
    ReportSizeEvent();
  }

  return NS_OK;
}

NS_IMETHODIMP nsWindow::Resize(double aWidth, double aHeight, bool aRepaint)
{
  if (mBounds.width == aWidth && mBounds.height == aHeight)
    return NS_OK;

  mBounds.width  = aWidth;
  mBounds.height = aHeight;

  ReportSizeEvent();

  return NS_OK;
}

void
nsWindow::ResizeCompositor(int width, int height)
{
  printf_stderr("SNORP: resizing compositor to %dx%d\n", width, height);
  if (!mCompositorSession) {
    for (nsWindow* child : mChildren) {
      if (child->mCompositorSession) {
        child->ResizeCompositor(width, height);
        return;
      }
    }

    NS_WARNING("No CompositorParent found!");
    return;
  }

  CompositorBridgeParent* compositor = mCompositorSession->GetInProcessBridge();
  compositor->ScheduleResumeOnCompositorThread(width, height);
}

void
nsWindow::NativeViewDestroyed()
{
  // This is called on the UI thread when the native view is destroyed
  // and before the widget is destroyed on the Gecko thread
  mNativeView = nullptr;
}

void
nsWindow::InsertText(const char* aText)
{
  for (size_t i = 0; i < strlen(aText); i++) {
    char c = aText[i];

    uint32_t keyCode = 0;
    if (c == '\r' || c == '\n') {
      keyCode = NS_VK_RETURN;
    }

    nsEventStatus status;
    WidgetKeyboardEvent pressEvent(true, eKeyPress, this);
    pressEvent.mKeyNameIndex = KEY_NAME_INDEX_USE_STRING;
    pressEvent.mCodeNameIndex = CODE_NAME_INDEX_UNKNOWN;
    pressEvent.mIsChar = (c >= ' ');
    pressEvent.mCharCode = pressEvent.mIsChar ? c : 0;
    pressEvent.mKeyCode = pressEvent.mIsChar ? 0 : keyCode;
    pressEvent.mTime = PR_IntervalNow();

    DispatchEvent(&pressEvent, status);
  }
}

void
nsWindow::DeleteCharacter()
{
  nsEventStatus status;
  WidgetKeyboardEvent pressEvent(true, eKeyPress, this);
  pressEvent.mKeyNameIndex = KEY_NAME_INDEX_USE_STRING;
  pressEvent.mCodeNameIndex = CODE_NAME_INDEX_UNKNOWN;
  pressEvent.mIsChar = false;
  pressEvent.mCharCode = 0;
  pressEvent.mKeyCode = NS_VK_BACK;
  pressEvent.mTime = PR_IntervalNow();

  DispatchEvent(&pressEvent, status);
}

/*
CompositorParent*
nsWindow::NewCompositorParent(int aSurfaceWidth, int aSurfaceHeight)
{
  // We override this to set mUseExternalSurfaceSize to true in the CompositorParent
  return new CompositorParent(this, true, aSurfaceWidth, aSurfaceHeight);
}
*/

NS_IMETHODIMP
nsWindow::MakeFullScreen(bool aFullScreen, nsIScreen* aTargetScreen)
{
  if (aFullScreen == mIsFullScreen) {
    return NS_OK;
  }

  __block BOOL fullScreen = aFullScreen ? YES : NO;
  RunBlockOnUIThread(^{
    if (mNativeView) {
      [mNativeView fullScreenChanged:fullScreen];
      RunBlockOnMainThread(^{
        mIsFullScreen = fullScreen;
        mWidgetListener->FullscreenChanged(mIsFullScreen);
      });
    }
  });
  return NS_OK;
}

NS_IMETHODIMP
nsWindow::Invalidate(const LayoutDeviceIntRect &aRect)
{
  return NS_OK;
}

NS_IMETHODIMP
nsWindow::SetFocus(bool aRaise)
{
  if (!IsTopLevel()) {
    nsWindow* top = static_cast<nsWindow*>(GetTopLevelWidget());
    return top->SetFocus(aRaise);
  }

  if (gActiveWindow != this) {
    if (gActiveWindow) {
      gActiveWindow->mWidgetListener->WindowDeactivated();
    }
    gActiveWindow = this;
    mWidgetListener->WindowActivated();
  }

  return NS_OK;
}

void nsWindow::ReportMoveEvent()
{
  NotifyWindowMoved(mBounds.x, mBounds.y);
}

void nsWindow::ReportSizeModeEvent(nsSizeMode aMode)
{
  if (mWidgetListener) {
    // This is terrible.
    nsSizeMode theMode;
    switch (aMode) {
    case nsSizeMode_Maximized:
      theMode = nsSizeMode_Maximized;
      break;
    case nsSizeMode_Fullscreen:
      theMode = nsSizeMode_Fullscreen;
      break;
    default:
      return;
    }
    mWidgetListener->SizeModeChanged(theMode);
  }
}

void nsWindow::ReportSizeEvent()
{
  if (mWidgetListener) {
    LayoutDeviceIntRect innerBounds = GetClientBounds();
    mWidgetListener->WindowResized(this, innerBounds.width, innerBounds.height);
  }
}

LayoutDeviceIntPoint nsWindow::WidgetToScreenOffset()
{
  LayoutDeviceIntPoint offset(0, 0);
  return offset;
}

NS_IMETHODIMP
nsWindow::DispatchEvent(mozilla::WidgetGUIEvent* aEvent,
            nsEventStatus& aStatus)
{
  aStatus = nsEventStatus_eIgnore;
  nsIWidgetListener* listener =
      mAttachedWidgetListener ? mAttachedWidgetListener : mWidgetListener;
  if (listener) {
    aStatus = listener->HandleEvent(aEvent, mUseAttachedEvents);
  }

  return NS_OK;
}

NS_IMETHODIMP_(void)
nsWindow::SetInputContext(const InputContext& aContext,
                          const InputContextAction& aAction)
{
  LOG("IME: %p SetInputContext: s=0x%X, 0x%X, action=0x%X, 0x%X", this,
      aContext.mIMEState.mEnabled, aContext.mIMEState.mOpen,
      aAction.mCause, aAction.mFocusChange);

  mInputContext = aContext;

  if (!mNativeView) {
    NS_WARNING("No native view for input!");
    return;
  }

  if (mInputContext.mIMEState.mEnabled == IMEState::ENABLED) {
    RunBlockOnUIThread(^{
      [mNativeView setKeyboardEnabled:YES];
    });
  } else if (mInputContext.mIMEState.mEnabled == IMEState::DISABLED) {
    RunBlockOnUIThread(^{
      [mNativeView setKeyboardEnabled:NO];
    });
  }
}

NS_IMETHODIMP_(mozilla::widget::InputContext)
nsWindow::GetInputContext()
{
  InputContext context = mInputContext;
  context.mIMEState.mOpen = IMEState::OPEN_STATE_NOT_SUPPORTED;
  return context;
}

void
nsWindow::SetBackgroundColor(const nscolor &aColor)
{
  __block nscolor color;
  RunBlockOnUIThread(^{
    if (mNativeView) {
      mNativeView.backgroundColor = [UIColor colorWithRed:NS_GET_R(color)
                       green:NS_GET_G(aColor)
                       blue:NS_GET_B(aColor)
                       alpha:NS_GET_A(aColor)];
    }
  });
}

void* nsWindow::GetNativeData(uint32_t aDataType)
{
  void* retVal = nullptr;

  switch (aDataType)
  {
  case NS_NATIVE_WIDGET:
  case NS_NATIVE_DISPLAY:
    retVal = (void*)mNativeView;
    break;

  case NS_NATIVE_WINDOW:
    retVal = [mNativeView window];
    break;

  case NS_NATIVE_GRAPHIC:
    NS_ERROR("Requesting NS_NATIVE_GRAPHIC on a UIKit child view!");
    break;

  case NS_NATIVE_OFFSETX:
    retVal = 0;
    break;

  case NS_NATIVE_OFFSETY:
    retVal = 0;
    break;

  case NS_NATIVE_PLUGIN_PORT:
    // not implemented
    break;
  case NS_RAW_NATIVE_IME_CONTEXT:
    retVal = NS_ONLY_ONE_NATIVE_IME_CONTEXT;
    break;
  }

  if (!retVal && mParent) {
    return mParent->GetNativeData(aDataType);
  }

  return retVal;
}

void nsWindow::SetNativeData(uint32_t aDataType, uintptr_t aVal)
{
  switch (aDataType) {
  case NS_NATIVE_WIDGET:
  case NS_NATIVE_DISPLAY:
    LOG("nsWindow[%p]::SetNativeData: %p", this, (void*)aVal);
    mNativeView = (GeckoWebView*)aVal;
    break;
  default:
    break;
  }
}

CGFloat
nsWindow::BackingScaleFactor()
{
  if (mNativeView) {
    return [mNativeView contentScaleFactor];
  }
  return [UIScreen mainScreen].scale;
}

int32_t
nsWindow::RoundsWidgetCoordinatesTo()
{
  if (BackingScaleFactor() == 2.0) {
    return 2;
  }
  return 1;
}

void
nsWindow::ConfigureAPZControllerThread()
{
  // nsBaseWidget tries to set the APZ controller thread here, but
  // we already did that in GeckoWebView
}

void
nsWindow::DispatchTouchInput(MultiTouchInput& aInput)
{
  if (!mAPZC) {
    return;
  }

  APZThreadUtils::AssertOnControllerThread();

  // First send it through the APZ code
  __block mozilla::layers::ScrollableLayerGuid guid;
  __block uint64_t inputBlockId;
  __block nsEventStatus result = mAPZC->ReceiveInputEvent(aInput, &guid, &inputBlockId);
  // If the APZ says to drop it, then we drop it
  if (result == nsEventStatus_eConsumeNoDefault) {
    return;
  }

  __block MultiTouchInput input = aInput;

  // Need to deliver this to Gecko on the main thread
  RunBlockOnMainThread(^{
    // We want this window to be focused if we're handling input there
    SetFocus(true);

    WidgetTouchEvent event = input.ToWidgetTouchEvent(this);
    ProcessUntransformedAPZEvent(&event, guid, inputBlockId, result);
  });
}
