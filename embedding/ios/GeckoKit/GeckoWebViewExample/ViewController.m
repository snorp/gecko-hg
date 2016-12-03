//
//  ViewController.m
//  GeckoWebViewExample
//
//  Created by Ted Mielczarek on 3/2/15.
//  Copyright (c) 2015 Mozilla. All rights reserved.
//

#import "ViewController.h"

#import <GeckoKit/GeckoKit.h>

#define START_URL @"about:mozilla"
#define SEARCH_URL_FORMAT @"https://duckduckgo.com/?q=%@"

@interface ViewController () {
}

- (void)updateBackForwardEnabled;

@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    
    self.locationText.layer.cornerRadius = 4.0f;
    self.locationText.layer.masksToBounds = YES;

    [self updateBackForwardEnabled];
    self.geckoView.navigationDelegate = self;
    self.geckoView.UIDelegate = self;

    NSLog(@"SNORP: Home directory is: %@\n", NSHomeDirectory());
    
    NSURLRequest* req = [NSURLRequest requestWithURL:[NSURL URLWithString:START_URL]];
    [self.geckoView loadRequest:req];
}

- (void)didReceiveMemoryWarning {
    [super didReceiveMemoryWarning];
    // Dispose of any resources that can be recreated.
}

- (IBAction)locationEdited:(id)sender {
    self.locationText.text = self.geckoView.URL.absoluteString;
}

- (IBAction)backPressed:(id)sender
{
    [self.geckoView goBack];
}

- (IBAction)forwardPressed:(id)sender
{
    [self.geckoView goForward];
}

- (IBAction)refreshPressed:(id)sender
{
    [self.geckoView reloadFromOrigin];
}

- (IBAction)stopPressed:(id)sender
{
    [self.geckoView stopLoading];
}

- (BOOL)textFieldShouldReturn:(UITextField*)textField
{
    if (!textField.text.length) {
        return YES;
    }
    
    NSURL* url = [NSURL URLWithString:textField.text];
    if (!url) {
        url = [NSURL URLWithString:[[NSString stringWithFormat:SEARCH_URL_FORMAT,
                                     textField.text]
                                    stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLQueryAllowedCharacterSet]]];
    }
    [self.geckoView loadRequest:[NSURLRequest requestWithURL:url]];
    [textField resignFirstResponder];
    return YES;
}

- (void)removeToolbarButton:(UIBarButtonItem*)item
{
    NSMutableArray* buttons = [self.toolbar.items mutableCopy];
    [buttons removeObject:item];
    [self.toolbar setItems:buttons];
}

- (void)addToolbarButton:(UIBarButtonItem*)item
{
    NSMutableArray* buttons = [self.toolbar.items mutableCopy];
    if (![buttons containsObject:item]) {
        [buttons addObject:item];
        [self.toolbar setItems:buttons];
    }
}

- (void)geckoView:(GeckoWebView *)view didCommitNavigation:(NSURL *)url
{
    [self.locationText setText:[url absoluteString]];
    [self updateBackForwardEnabled];

    [self removeToolbarButton:self.refreshButton];
    [self addToolbarButton:self.stopButton];
}

- (void)geckoView:(GeckoWebView *)view didFinishNavigation:(NSURL *)url
{
    [self updateBackForwardEnabled];
    [self removeToolbarButton:self.stopButton];
    [self addToolbarButton:self.refreshButton];
}

- (void)geckoView:(GeckoWebView *)view fullScreenChanged:(BOOL)fullScreen
{
    self.geckoViewTopConstraint.constant = fullScreen ? 0 : 46;
    self.geckoViewBottomConstraint.constant = fullScreen ? 0 : 44;
    [UIView animateWithDuration:.5 animations:^{
        [self.geckoView layoutIfNeeded];
    }];
}


- (void)updateBackForwardEnabled
{
    self.backButton.enabled = self.geckoView.canGoBack;
    self.forwardButton.enabled = self.geckoView.canGoForward;
}

@end
