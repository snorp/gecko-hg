//
//  ViewController.h
//  GeckoWebViewExample
//
//  Created by Ted Mielczarek on 3/2/15.
//  Copyright (c) 2015 Mozilla. All rights reserved.
//

#import <UIKit/UIKit.h>
#import <GeckoKit/GeckoKit.h>

@class GeckoWebView;

@interface ViewController : UIViewController <GeckoWebViewNavigationDelegate, GeckoWebViewUIDelegate>

@property (weak, nonatomic) IBOutlet UIView *locationBar;
@property (weak, nonatomic) IBOutlet GeckoWebView *geckoView;
@property (weak, nonatomic) IBOutlet NSLayoutConstraint *geckoViewTopConstraint;
@property (weak, nonatomic) IBOutlet NSLayoutConstraint *geckoViewBottomConstraint;
@property (weak, nonatomic) IBOutlet UITextField *locationText;
@property (weak, nonatomic) IBOutlet UIBarButtonItem *backButton;
@property (weak, nonatomic) IBOutlet UIBarButtonItem *forwardButton;
@property (strong, nonatomic) IBOutlet UIBarButtonItem *refreshButton;
@property (strong, nonatomic) IBOutlet UIBarButtonItem *stopButton;
@property (weak, nonatomic) IBOutlet UIToolbar *toolbar;

- (IBAction)locationEdited:(id)sender;

- (IBAction)backPressed:(id)sender;
- (IBAction)forwardPressed:(id)sender;
- (IBAction)refreshPressed:(id)sender;
- (IBAction)stopPressed:(id)sender;

@end

